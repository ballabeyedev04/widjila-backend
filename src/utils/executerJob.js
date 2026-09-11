'use strict';

const os = require('node:os');
const logger = require('./logger.js');
const metrics = require('./metrics.js');
const { executerDansContexte } = require('./requestContext.js');

/**
 * Enveloppe d'exécution des tâches planifiées (node-cron).
 *
 * ## Ce qui manquait
 *
 * Chaque job attrapait ses propres erreurs et les journalisait par
 * `logger.error('…', err.message)` — or winston JETTE ce second argument :
 * la ligne disait « erreur marquage en retard : » et rien d'autre. Et rien
 * d'autre ne gardait trace d'une exécution :
 *   - un job pouvait échouer chaque nuit sans qu'aucun compteur le signale ;
 *   - un worker tué PENDANT un job laissait le travail à moitié fait, sans
 *     aucune trace de l'interruption ;
 *   - un passage manqué (serveur arrêté à l'heure du cron) était perdu
 *     jusqu'à l'échéance suivante — une semaine pour la purge RGPD ;
 *   - la seule garde contre les doublons était « worker PM2 n° 0 » : deux
 *     hôtes (ou deux conteneurs) exécutaient chacun chaque job ;
 *   - une coupure de base de quelques secondes à 22h00 faisait sauter le
 *     marquage des retards pour la journée.
 *
 * ## Ce que fait l'enveloppe, à chaque exécution
 *
 *   1. VERROU inter-process : `pg_try_advisory_lock` sur une connexion
 *      dédiée. Une autre instance qui détient le verrou → exécution ignorée.
 *      Verrou de SESSION : si le process meurt, PostgreSQL le libère seul.
 *   2. HISTORIQUE : une ligne `job_executions` (en_cours → succes / echec),
 *      avec la durée, le bilan, le message d'erreur et l'instance.
 *   3. JOURNAL et MÉTRIQUES : durée, succès, échec avec la PILE ; un
 *      identifiant d'exécution sert de `requestId` à toutes les lignes.
 *   4. REPRISE bornée : une erreur PASSAGÈRE (base injoignable, délai
 *      dépassé, service externe indisponible) est retentée au plus
 *      `maxTentatives` fois, avec un délai exponentiel et une part
 *      aléatoire. Une erreur définitive (bug, donnée invalide) ne l'est pas :
 *      la rejouer produirait le même échec.
 *   5. Aucune exception ne remonte à node-cron.
 *
 * Et au démarrage du worker leader (`reprendreApresDemarrage`) :
 *   - les exécutions restées `en_cours` passent `interrompu` ;
 *   - un job de maintenance dont le dernier succès date de plus d'une période
 *     est rattrapé immédiatement.
 */

const MAX_TENTATIVES = parseInt(process.env.JOB_MAX_TENTATIVES || '3', 10);
const DELAI_BASE_REPRISE_MS = parseInt(process.env.JOB_DELAI_REPRISE_MS || '60000', 10);
const HISTORIQUE_JOURS = parseInt(process.env.JOB_HISTORIQUE_JOURS || '180', 10);

const INSTANCE = `${os.hostname()}#${process.env.NODE_APP_INSTANCE ?? '0'}`;

/** Jobs déclarés — parcourus au démarrage pour la reprise. */
const registre = new Map();

/** Reprises programmées — annulées à l'arrêt propre du serveur. */
const reprisesEnAttente = new Set();

/**
 * Vrai si l'erreur a des chances de disparaître d'elle-même : base
 * injoignable ou surchargée, délai dépassé, service externe indisponible,
 * connexion réseau coupée.
 */
function estErreurTransitoire(err) {
  if (!err) return false;
  if (err.statusCode === 503) return true; // ServiceIndisponibleError (délai, disjoncteur)
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(err.code)) return true;
  // Chargé à l'appel : le gestionnaire d'erreurs connaît la liste exacte des
  // erreurs de connexion Sequelize et des codes PostgreSQL « indisponible ».
  const { estBaseIndisponible } = require('../middlewares/errorHandler.middleware.js');
  return estBaseIndisponible(err);
}

// ── Verrou PostgreSQL ───────────────────────────────────────────────────────

/**
 * Exécute `fn` sous verrou exclusif `job:<nom>`, sur une connexion retirée
 * du pool pour la durée du job.
 * @returns {Promise<{ verrouObtenu: boolean, resultat?: any }>}
 */
async function verrouPostgres(nom, fn) {
  const sequelize = require('../config/db.js');
  const gestionnaire = sequelize.connectionManager;
  const connexion = await gestionnaire.getConnection();
  const cle = `job:${nom}`;
  let obtenu = false;
  try {
    const reponse = await connexion.query('SELECT pg_try_advisory_lock(hashtext($1)) AS obtenu', [cle]);
    obtenu = reponse.rows?.[0]?.obtenu === true;
    if (!obtenu) return { verrouObtenu: false };
    return { verrouObtenu: true, resultat: await fn() };
  } finally {
    if (obtenu) {
      await connexion.query('SELECT pg_advisory_unlock(hashtext($1))', [cle]).catch((err) => {
        // Connexion perdue : la session est close, PostgreSQL a déjà libéré le verrou.
        logger.warn(`[job] ${nom} : libération du verrou impossible`, { error: err.message });
      });
    }
    await Promise.resolve(gestionnaire.releaseConnection(connexion)).catch(() => {});
  }
}

// ── Historique en base ──────────────────────────────────────────────────────

const journalPostgres = {
  async debut(nom, tentative) {
    const { JobExecution } = require('../models/index.js');
    const ligne = await JobExecution.create({ job: nom, statut: 'en_cours', tentative, debut: new Date(), instance: INSTANCE });
    return ligne.id;
  },
  async fin(id, { statut, dureeMs, erreur, resultat }) {
    const { JobExecution } = require('../models/index.js');
    await JobExecution.update({
      statut,
      fin: new Date(),
      duree_ms: Math.round(dureeMs),
      erreur: erreur ? String(erreur.message || erreur).slice(0, 2000) : null,
      resultat: resultat && typeof resultat === 'object' ? resultat : null,
    }, { where: { id } });
  },
  async marquerInterrompus(nom) {
    const { JobExecution } = require('../models/index.js');
    const [nombre] = await JobExecution.update({
      statut: 'interrompu',
      fin: new Date(),
      erreur: 'Process arrêté pendant l’exécution (redémarrage, crash ou déploiement).',
    }, { where: { job: nom, statut: 'en_cours' } });
    return nombre;
  },
  async dernierSucces(nom) {
    const { JobExecution } = require('../models/index.js');
    const ligne = await JobExecution.findOne({ where: { job: nom, statut: 'succes' }, order: [['debut', 'DESC']] });
    return ligne ? ligne.debut : null;
  },
  async purgerAnciens(jours) {
    const { Op } = require('sequelize');
    const { JobExecution } = require('../models/index.js');
    return JobExecution.destroy({ where: { debut: { [Op.lt]: new Date(Date.now() - jours * 86_400_000) } } });
  },
};

/**
 * L'historique est un TÉMOIN, pas une condition : s'il ne peut pas être écrit,
 * le job s'exécute quand même (l'échec est journalisé et compté).
 */
async function temoin(nom, operation, fn) {
  try {
    return await fn();
  } catch (err) {
    metrics.incrementer('job.historique_indisponible');
    logger.warn(`[job] ${nom} : historique non écrit (${operation})`, { error: err.message });
    return null;
  }
}

// ── Enveloppe ───────────────────────────────────────────────────────────────

/**
 * @param {string} nom — identifiant stable du job (journaux, métriques, historique, verrou)
 * @param {() => Promise<any>} tache — le travail ; DOIT lever en cas d'échec
 * @param {object} [options]
 * @param {number} [options.periodeMs] — périodicité, pour le rattrapage
 * @param {boolean} [options.rattrapage=false] — rattraper un passage manqué au démarrage
 * @param {number} [options.maxTentatives] — tentatives au total sur erreur passagère
 * @param {number} [options.delaiBaseRepriseMs] — premier délai de reprise (doublé ensuite)
 * @param {Function} [options.verrou] — injectable (tests)
 * @param {object} [options.journal] — injectable (tests)
 * @returns {() => Promise<{ statut: 'succes'|'echec'|'ignore', resultat?: any, erreur?: Error }>}
 */
function envelopperJob(nom, tache, {
  periodeMs = null,
  rattrapage = false,
  maxTentatives = MAX_TENTATIVES,
  delaiBaseRepriseMs = DELAI_BASE_REPRISE_MS,
  verrou = verrouPostgres,
  journal = journalPostgres,
} = {}) {
  let enCours = false;
  let reprise = null;

  const annulerReprise = () => {
    if (reprise) {
      clearTimeout(reprise);
      reprisesEnAttente.delete(reprise);
      reprise = null;
    }
  };

  const programmerReprise = (tentative, err) => {
    annulerReprise();
    const base = delaiBaseRepriseMs * 2 ** (tentative - 2);
    const delai = Math.round(base + Math.random() * base * 0.5);
    logger.warn(`[job] ${nom} : erreur passagère — tentative ${tentative}/${maxTentatives} dans ${Math.round(delai / 1000)} s`, {
      job: nom, tentative, error: err.message,
    });
    metrics.incrementer(`job.reprise.${nom}`);
    reprise = setTimeout(() => {
      reprisesEnAttente.delete(reprise);
      reprise = null;
      executer(tentative);
    }, delai);
    reprise.unref?.();
    reprisesEnAttente.add(reprise);
  };

  async function executer(tentative = 1) {
    if (enCours) {
      metrics.jobIgnore(nom);
      logger.warn(`[job] ${nom} : l’exécution précédente n’est pas terminée — déclenchement ignoré`, { job: nom });
      return { statut: 'ignore' };
    }
    // Un passage planifié remplace une reprise encore en attente.
    if (tentative === 1) annulerReprise();

    enCours = true;
    const debut = Date.now();
    const idExecution = `job-${nom}-${debut.toString(36)}`;
    let idHistorique = null;

    try {
      const sortie = await executerDansContexte({ requestId: idExecution, job: nom }, () => verrou(nom, async () => {
        metrics.jobDemarre(nom);
        idHistorique = await temoin(nom, 'début', () => journal.debut(nom, tentative));
        return tache();
      }));

      if (!sortie.verrouObtenu) {
        metrics.jobIgnore(nom);
        logger.info(`[job] ${nom} : déjà en cours sur une autre instance — ignoré ici`, { job: nom, requestId: idExecution });
        return { statut: 'ignore' };
      }

      const dureeMs = Date.now() - debut;
      metrics.jobTermine(nom, { succes: true, dureeMs });
      logger.info(`[job] ${nom} : terminé en ${dureeMs} ms`, {
        job: nom, dureeMs, tentative, requestId: idExecution, bilan: sortie.resultat,
      });
      if (idHistorique) {
        await temoin(nom, 'fin', () => journal.fin(idHistorique, { statut: 'succes', dureeMs, resultat: sortie.resultat }));
      }
      return { statut: 'succes', resultat: sortie.resultat };
    } catch (err) {
      const dureeMs = Date.now() - debut;
      const transitoire = estErreurTransitoire(err);
      metrics.jobTermine(nom, { succes: false, dureeMs, erreur: err });
      logger.error(`[job] ${nom} : échec après ${dureeMs} ms (tentative ${tentative}/${maxTentatives}) — ${err.message}`, {
        job: nom, dureeMs, tentative, transitoire, requestId: idExecution, error: err.message, stack: err.stack,
      });
      if (idHistorique) {
        await temoin(nom, 'fin', () => journal.fin(idHistorique, { statut: 'echec', dureeMs, erreur: err }));
      }

      if (transitoire && tentative < maxTentatives) {
        programmerReprise(tentative + 1, err);
      } else if (transitoire) {
        metrics.incrementer(`job.abandon.${nom}`);
        logger.error(`[job] ${nom} : abandon après ${tentative} tentative(s) — prochain passage à l’échéance planifiée`, { job: nom });
      }
      return { statut: 'echec', erreur: err };
    } finally {
      enCours = false;
    }
  }

  const point = () => executer(1);
  registre.set(nom, { executer: point, periodeMs, rattrapage, verrou, journal });
  return point;
}

/**
 * Au démarrage du worker leader, AVANT de planifier les crons :
 *   - les exécutions restées `en_cours` (process mort pendant le job) sont
 *     marquées `interrompu` — sous verrou, pour ne jamais marquer celle
 *     qu'une autre instance est réellement en train d'exécuter ;
 *   - un job de maintenance en retard sur sa période est rattrapé ;
 *   - l'historique au-delà de JOB_HISTORIQUE_JOURS est purgé.
 */
async function reprendreApresDemarrage() {
  for (const [nom, def] of registre) {
    try {
      const marque = await def.verrou(nom, () => def.journal.marquerInterrompus(nom));
      if (marque.verrouObtenu && marque.resultat > 0) {
        metrics.incrementer('job.interrompu', marque.resultat);
        logger.warn(`[job] ${nom} : ${marque.resultat} exécution(s) interrompue(s) par l’arrêt du process — marquée(s) « interrompu »`, { job: nom });
      }

      if (!def.rattrapage || !def.periodeMs) continue;
      const dernier = await def.journal.dernierSucces(nom);
      // Aucun historique : premier démarrage — on attend l'échéance planifiée.
      if (!dernier) continue;
      const retardMs = Date.now() - new Date(dernier).getTime();
      if (retardMs > def.periodeMs * 1.1) {
        logger.warn(`[job] ${nom} : dernier succès il y a ${Math.round(retardMs / 3_600_000)} h — exécution de rattrapage`, { job: nom });
        metrics.incrementer(`job.rattrapage.${nom}`);
        def.executer();
      }
    } catch (err) {
      logger.warn(`[job] ${nom} : reprise au démarrage impossible`, { job: nom, error: err.message });
    }
  }

  const premier = registre.values().next().value;
  if (premier) {
    await temoin('historique', 'purge', () => premier.journal.purgerAnciens(HISTORIQUE_JOURS));
  }
}

/** Annule les reprises programmées — à l'arrêt propre, avant de fermer la base. */
function annulerReprises() {
  for (const minuteur of reprisesEnAttente) clearTimeout(minuteur);
  reprisesEnAttente.clear();
}

module.exports = {
  envelopperJob,
  reprendreApresDemarrage,
  annulerReprises,
  estErreurTransitoire,
  verrouPostgres,
  journalPostgres,
};
