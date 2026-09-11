'use strict';

const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { ReserveHistorique } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const logger = require('../utils/logger.js');
const { envelopperJob } = require('../utils/executerJob.js');

/**
 * Job — passage automatique des réserves en retard (module 5 / cahier des
 * charges § Gestion automatique du retard).
 *
 * Une réserve est « en retard » quand sa date limite est DÉPASSÉE — la veille
 * au plus tard — alors que le travail n'a pas encore été déclaré fait.
 *
 * ── Ce que faisait l'ancien job, et pourquoi c'était faux ─────────────────
 *  1. Il écrasait TOUT statut hors verdict, `corrigee` et `a_verifier`
 *     compris : une réserve déclarée corrigée, en attente de contrôle, repassait
 *     « en retard » chaque nuit — et perdait sa place dans la file de contrôle.
 *  2. Aucune ligne d'historique : la réserve changeait de statut sans trace,
 *     alors que la règle est que tout changement est historisé.
 *  3. Les notifications partaient d'une lecture FAITE AVANT la mise à jour :
 *     une réserve validée entre les deux recevait une alerte à tort.
 *  4. `date_limite < maintenant` comparait une DATE à un instant en UTC : à 22h
 *     heure de Paris, une réserve due le jour même était déjà « en retard ».
 *
 * ── Ce qu'il fait ─────────────────────────────────────────────────────────
 *  - une transaction : sélection verrouillée des réserves ÉLIGIBLES, mise à
 *    jour, et une ligne d'historique par réserve — tout ou rien ;
 *  - notifications ensuite, pour les SEULES lignes réellement modifiées ;
 *  - idempotent : une réserve déjà « en_retard » n'est plus éligible, le job
 *    peut être rejoué (rattrapage au démarrage, reprise sur erreur passagère)
 *    sans rien dupliquer.
 *
 * Aucune capture d'erreur ici : c'est `envelopperJob` qui journalise l'échec,
 * le compte dans les métriques et retente les erreurs passagères.
 */

// Travail NON encore déclaré fait. `corrigee` et `a_verifier` sont exclus :
// l'entreprise a rendu sa copie, le retard éventuel appartient au contrôle.
const STATUTS_ELIGIBLES = ['creee', 'affectee', 'prise_en_charge', 'en_cours', 'rouverte'];

const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

/** Date du jour (AAAA-MM-JJ) dans le fuseau des échéances. */
function aujourdhui(fuseau = CRON_TZ, maintenant = new Date()) {
  // 'en-CA' formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(maintenant);
}

async function marquerReservesEnRetard({ maintenant = new Date() } = {}) {
  const jour = aujourdhui(CRON_TZ, maintenant);

  const marquees = await sequelize.transaction(async (t) => {
    // SELECT … FOR UPDATE : un changement de statut concurrent (validation à
    // 22h00) attend la fin de ce passage, ou le fait attendre — jamais les
    // deux écritures entremêlées.
    const lignes = await sequelize.query(
      `WITH cibles AS (
         SELECT id, statut
           FROM reserves
          WHERE deleted_at IS NULL
            AND date_limite IS NOT NULL
            AND date_limite < :jour
            AND statut IN (:eligibles)
          FOR UPDATE
       )
       UPDATE reserves r
          SET statut = 'en_retard', updated_at = NOW()
         FROM cibles c
        WHERE r.id = c.id
       RETURNING r.id, r.numero, r.titre, r.assigne_a AS "assigneA", r.cree_par AS "creePar",
                 c.statut AS "ancienStatut"`,
      {
        replacements: { jour, eligibles: STATUTS_ELIGIBLES },
        type: QueryTypes.SELECT,
        transaction: t,
      }
    );

    if (lignes.length) {
      await ReserveHistorique.bulkCreate(lignes.map((r) => ({
        reserveId: r.id,
        utilisateurId: null, // action du système, pas d'un utilisateur
        action: 'statut',
        anciennes_valeurs: { statut: r.ancienStatut },
        nouvelles_valeurs: { statut: 'en_retard', motif: `échéance dépassée (avant le ${jour})` },
      })), { transaction: t });
    }
    return lignes;
  });

  if (!marquees.length) return { reserves: 0 };
  logger.info(`[job] ${marquees.length} réserve(s) passée(s) en retard`);

  // Après le commit, et uniquement pour les lignes réellement passées en
  // retard par CE passage.
  for (const r of marquees) {
    const dest = r.assigneA || r.creePar;
    if (!dest) continue;
    await NotificationService.notifier({
      utilisateurId: dest,
      type: 'reserve.en_retard',
      titre: 'Réserve en retard',
      message: `La réserve ${r.numero} « ${r.titre} » a dépassé sa date limite.`,
      donnees: { reserveId: r.id, statut: 'en_retard' },
    });
  }

  return { reserves: marquees.length };
}

// CORRECTIF (fuseau horaire des crons non fixé) : sans option `timezone`,
// node-cron se cale sur le TZ système. Dans le conteneur Docker ce TZ est UTC :
// le « 22h00 » annoncé s'exécutait à minuit heure de Paris (23h00 en hiver),
// c'est-à-dire le LENDEMAIN — les réserves échues du jour n'étaient donc pas
// marquées à la bonne date. Fuseau explicite, surchargeable par CRON_TZ.
// API vérifiée sur node-cron 4.6.0 : schedule(expr, fn, { timezone }).
const UN_JOUR_MS = 24 * 60 * 60 * 1000;

/**
 * Exécution enveloppée : journal, métriques, verrou, historique et reprise
 * (voir utils/executerJob.js). `rattrapage` : un passage manqué (serveur
 * arrêté à 22h00) est rejoué au démarrage suivant — le marquage est
 * idempotent, le filtre sur le statut l'empêche de traiter deux fois une
 * même réserve.
 */
const executerMarquageEnRetard = envelopperJob('reserves-en-retard', marquerReservesEnRetard, {
  periodeMs: UN_JOUR_MS,
  rattrapage: true,
});

/**
 * Planifie le job (chaque jour à 22h00, fuseau CRON_TZ).
 * @returns {import('node-cron').ScheduledTask} tâche planifiée, à conserver
 *   pour pouvoir l'arrêter lors de l'arrêt propre du serveur (voir server.js).
 */
function startEnRetardJob() {
  const task = cron.schedule('0 22 * * *', executerMarquageEnRetard, { timezone: CRON_TZ });
  logger.info(`[job] Planifié : marquage des réserves en retard (22h00 ${CRON_TZ})`);
  return task;
}

module.exports = {
  marquerReservesEnRetard, executerMarquageEnRetard, startEnRetardJob,
  aujourdhui, STATUTS_ELIGIBLES,
};
