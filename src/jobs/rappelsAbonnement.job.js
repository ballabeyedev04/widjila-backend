'use strict';

const { Op } = require('sequelize');
const cron = require('node-cron');
const {
  AbonnementSouscrit, Organisation, Utilisateur, Devis,
} = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');
const { sendEcheanceAbonnementEmail } = require('../infrastructure/emailService.js');
const logger = require('../utils/logger.js');
const { envelopperJob } = require('../utils/executerJob.js');
const { FACTURATION } = require('../config/roles.js');
const { LIMITE_CHANTIERS, LIMITE_UTILISATEURS } = require('../config/offreGratuite.js');

/**
 * Rappels d'échéance d'abonnement, et clôture de ce qui a expiré
 * (cahier des charges « Premium sur devis » § 9).
 *
 * ── Ce que fait cette tâche ───────────────────────────────────────────────
 *
 *  1. PRÉVENIR avant l'échéance — à J-30, J-7 et J-1. Un contrat de BTP se
 *     renouvelle avec un bon de commande et une signature : prévenir la
 *     veille ne sert à rien, d'où le premier rappel un mois avant.
 *
 *  2. CLÔTURER ce qui est échu : la souscription passe à `expiree` et
 *     l'organisation n'est plus marquée abonnée. Sans cela, la ligne restait
 *     `active` indéfiniment — l'administration lisait un abonnement en cours
 *     qui ne couvrait plus rien.
 *
 *  3. FERMER les devis dont la validité est passée, pour que la liste de
 *     l'administration dise le vrai sans que personne n'ait à l'ouvrir.
 *
 * ── La politique d'expiration, annoncée dès le premier rappel ─────────────
 *
 * À l'échéance, l'organisation ne perd PAS son travail : elle bascule sur
 * l'offre gratuite (un chantier, deux utilisateurs, toutes les
 * fonctionnalités — voir `config/offreGratuite.js`). Ni coupure, ni lecture
 * seule : les données restent accessibles, seuls les volumes se resserrent.
 * Le message le dit explicitement — une échéance qui fait peur pousse à
 * exporter, pas à renouveler.
 *
 * ── Deux canaux, une seule décision d'envoi ───────────────────────────────
 *
 * Chaque rappel part en NOTIFICATION dans l'application et en COURRIEL. Le
 * second n'est pas un luxe : le responsable qui signe le renouvellement
 * n'ouvre pas l'application tous les jours, et une échéance manquée se paie
 * en interruption de service.
 *
 * Le courriel est best-effort : son échec (serveur SMTP injoignable,
 * disjoncteur ouvert) ne doit jamais empêcher la notification ni faire
 * échouer la tâche. C'est l'anti-doublon de la NOTIFICATION qui décide des
 * deux envois — ainsi un courriel perdu n'est pas renvoyé en boucle le
 * lendemain, et le destinataire garde la trace dans l'application.
 *
 * ── Pourquoi pas de colonne « dernier rappel » ────────────────────────────
 *
 * L'anti-doublon s'appuie sur les NOTIFICATIONS déjà émises
 * (`NotificationService.dejaNotifie`, avec le palier dans les données) :
 * c'est la même trace que celle que l'utilisateur voit, elle ne peut pas
 * diverger de ce qui a réellement été envoyé, et un redémarrage ne la perd
 * pas. Deux exécutions dans la même journée n'envoient donc qu'un rappel.
 */

/** Paliers de rappel, en jours avant l'échéance. Du plus lointain au plus proche. */
const PALIERS_JOURS = [30, 7, 1];

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

/** Jours entiers restants avant [dateFin], arrondis au jour supérieur. */
function joursRestants(dateFin, maintenant = new Date()) {
  return Math.ceil((new Date(dateFin) - maintenant) / MS_PAR_JOUR);
}

/**
 * Palier à appliquer pour une échéance donnée : le plus petit palier encore
 * atteint. À 12 jours, c'est le palier 30 (déjà passé, donc déjà envoyé) ;
 * à 5 jours, le palier 7. `null` au-delà du plus lointain.
 */
function palierPour(jours) {
  for (const palier of PALIERS_JOURS) {
    if (jours <= palier) {
      // On continue pour trouver le plus petit palier atteint.
      const plusPetit = PALIERS_JOURS.filter((p) => jours <= p);
      return Math.min(...plusPetit);
    }
  }
  return null;
}

/**
 * Envoie le courriel d'échéance, sans jamais faire échouer la tâche.
 *
 * Un seul appel pour tous les destinataires : `sendEmail` accepte une liste,
 * et le message part à TOUS ceux qui peuvent reconduire — un responsable en
 * congé ne doit pas suffire à laisser passer une échéance.
 */
async function prevenirParCourriel(variante, souscription, comptes, jours = null) {
  const adresses = comptes.map((c) => c.email).filter(Boolean);
  if (adresses.length === 0) return;

  try {
    await sendEcheanceAbonnementEmail({
      to: adresses,
      variante,
      // Le prénom n'est personnalisé que s'il y a UN destinataire : « Bonjour
      // Balla » adressé à trois personnes sonne faux.
      prenom: adresses.length === 1 ? comptes[0].prenom : null,
      organisationNom: souscription.organisation?.nom ?? null,
      planNom: souscription.plan_nom,
      dateFin: souscription.date_fin
        ? new Date(souscription.date_fin).toLocaleDateString('fr-FR')
        : null,
      jours,
      limiteChantiers: LIMITE_CHANTIERS,
      limiteUtilisateurs: LIMITE_UTILISATEURS,
    });
  } catch (err) {
    // Best-effort : la notification dans l'application est déjà partie, et
    // c'est elle qui porte la trace. Un SMTP en panne n'annule pas un rappel.
    logger.warn(
      `[abonnement] Courriel d'échéance non envoyé pour ${souscription.organisationId} : ${err.message}`
    );
  }
}

/** Qui doit être prévenu dans l'organisation : ceux qui peuvent renouveler. */
async function destinataires(organisationId) {
  return Utilisateur.findAll({
    where: { organisationId, statut: 'actif', role: { [Op.in]: FACTURATION } },
    attributes: ['id', 'email', 'prenom', 'nom'],
  });
}

/**
 * Rappels avant échéance.
 *
 * Ne concerne QUE les abonnements payants en cours : une organisation sur
 * l'offre gratuite n'a pas d'échéance, et il n'y a rien à lui rappeler.
 */
async function rappelerEcheances() {
  const maintenant = new Date();
  const horizon = new Date(maintenant.getTime() + Math.max(...PALIERS_JOURS) * MS_PAR_JOUR);

  const souscriptions = await AbonnementSouscrit.findAll({
    where: {
      statut: 'active',
      date_fin: { [Op.between]: [maintenant, horizon] },
    },
    include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'] }],
  });

  for (const souscription of souscriptions) {
    const jours = joursRestants(souscription.date_fin, maintenant);
    const palier = palierPour(jours);
    if (palier === null) continue;

    const comptes = await destinataires(souscription.organisationId);
    if (comptes.length === 0) {
      logger.warn(
        `[abonnement] Échéance dans ${jours} j pour ${souscription.organisationId}, `
        + 'mais aucun compte de facturation à prévenir'
      );
      continue;
    }

    // Le palier entre dans les données : c'est lui qui distingue le rappel
    // de J-30 de celui de J-7, et qui permet à `dejaNotifie` de ne pas
    // confondre les deux.
    const donnees = { souscriptionId: souscription.id, palier };

    // Ceux qui n'avaient pas encore reçu CE palier : eux seuls reçoivent le
    // courriel, pour qu'un second passage dans la journée n'en renvoie pas.
    const aPrevenir = [];

    for (const compte of comptes) {
      if (await NotificationService.dejaNotifie(compte.id, 'abonnement.echeance', donnees)) continue;
      aPrevenir.push(compte);

      await NotificationService.notifier({
        utilisateurId: compte.id,
        type: 'abonnement.echeance',
        titre: jours <= 1 ? 'Votre abonnement expire demain' : `Votre abonnement expire dans ${jours} jours`,
        message:
          `La formule ${souscription.plan_nom} de ${souscription.organisation?.nom ?? 'votre organisation'} `
          + `arrive à échéance le ${new Date(souscription.date_fin).toLocaleDateString('fr-FR')}. `
          + 'Sans renouvellement, vous conserverez vos données et basculerez sur l’offre gratuite '
          + `(${LIMITE_CHANTIERS} chantier, ${LIMITE_UTILISATEURS} utilisateurs).`,
        donnees,
      });
    }

    if (aPrevenir.length === 0) continue;
    await prevenirParCourriel('approche', souscription, aPrevenir, jours);

    logger.info(
      `[abonnement] Rappel J-${palier} envoyé pour ${souscription.organisationId} `
      + `(${aPrevenir.length} destinataire(s))`
    );
  }
}

/**
 * Clôture des abonnements échus.
 *
 * `DroitsService` ignore déjà une souscription dont l'échéance est passée —
 * les droits retombent donc d'eux-mêmes sur l'offre gratuite, sans attendre
 * cette tâche. Ce qu'elle apporte, c'est la VÉRITÉ DE LA LIGNE : un
 * abonnement affiché « actif » alors qu'il ne couvre plus rien trompe
 * l'administration, l'historique et toute reprise comptable.
 */
async function cloturerEchus() {
  const maintenant = new Date();

  const echus = await AbonnementSouscrit.findAll({
    where: { statut: 'active', date_fin: { [Op.lt]: maintenant } },
  });

  for (const souscription of echus) {
    await souscription.update({ statut: 'expiree' });
    // Remet `is_subscribed` et le libellé de formule en accord avec la
    // réalité : ce sont eux que lisent les écrans et `checkSubscription`.
    await SubscriptionService._synchroniserOrganisation(souscription);

    logger.info(
      `[abonnement] ${souscription.plan_code} expiré pour ${souscription.organisationId} `
      + '— bascule sur l’offre gratuite'
    );

    const comptes = await destinataires(souscription.organisationId);
    const donnees = { souscriptionId: souscription.id };
    const aPrevenir = [];

    for (const compte of comptes) {
      if (await NotificationService.dejaNotifie(compte.id, 'abonnement.expire', donnees)) continue;
      aPrevenir.push(compte);
      await NotificationService.notifier({
        utilisateurId: compte.id,
        type: 'abonnement.expire',
        titre: 'Votre abonnement a expiré',
        message:
          `La formule ${souscription.plan_nom} est arrivée à échéance. Vos données restent accessibles : `
          + `vous êtes désormais sur l’offre gratuite (${LIMITE_CHANTIERS} chantier, `
          + `${LIMITE_UTILISATEURS} utilisateurs).`,
        donnees,
      });
    }

    if (aPrevenir.length > 0) await prevenirParCourriel('expire', souscription, aPrevenir);
  }

  return echus.length;
}

/**
 * Devis dont la validité est passée.
 *
 * Le service les referme déjà À LA LECTURE (`DevisService._perimerSiBesoin`),
 * ce qui suffit au client. Ici, c'est pour l'administration : sa liste doit
 * dire le vrai sans que quiconque ait ouvert le devis.
 */
async function fermerDevisPerimes() {
  const [fermes] = await Devis.update(
    { statut: 'expire' },
    {
      where: {
        statut: { [Op.in]: ['brouillon', 'envoye'] },
        expire_le: { [Op.lt]: new Date() },
      },
    }
  );
  if (fermes > 0) logger.info(`[devis] ${fermes} devis expiré(s) refermé(s)`);
  return fermes;
}

// Fuseau explicite, comme les autres tâches : dans le conteneur, le TZ
// système est UTC, et un « 08h00 » annoncé partirait à 09h00 à Paris.
const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

// Trois exécutions enveloppées DISTINCTES : l'échec des rappels ne doit
// empêcher ni la clôture des abonnements échus, ni celle des devis.
const executerRappels = envelopperJob('rappels-abonnement', rappelerEcheances);
const executerClotures = envelopperJob('cloture-abonnements-echus', cloturerEchus);
const executerDevis = envelopperJob('cloture-devis-perimes', fermerDevisPerimes);

/**
 * Planifie les rappels et les clôtures (quotidien à 08h00, fuseau CRON_TZ).
 *
 * Une heure après les rappels de réserves (07h00) : deux vagues de
 * notifications à la même minute se gênent, et celle-ci est moins urgente.
 *
 * @returns {import('node-cron').ScheduledTask} tâche planifiée, à conserver
 *   pour l'arrêt propre du serveur (voir server.js).
 */
function startRappelsAbonnementJob() {
  const task = cron.schedule('0 8 * * *', async () => {
    // Les enveloppes ne lèvent jamais : chaque étape s'exécute quoi qu'il
    // arrive à la précédente. La clôture d'abord — un abonnement échu ce
    // matin ne doit pas recevoir un rappel « expire dans 1 jour ».
    await executerClotures();
    await executerRappels();
    await executerDevis();
  }, { timezone: CRON_TZ });

  logger.info(`[job] Planifié : rappels d’échéance d’abonnement et clôtures (08h00 ${CRON_TZ})`);
  return task;
}

module.exports = {
  rappelerEcheances,
  cloturerEchus,
  fermerDevisPerimes,
  startRappelsAbonnementJob,
  PALIERS_JOURS,
  joursRestants,
  palierPour,
};
