'use strict';

const cron = require('node-cron');
const { Op } = require('sequelize');
const models = require('../models/index.js');
const sequelize = require('../config/db.js');

const {
  ConnexionLog, AuditLog, Notification, MfaChallenge, UserOtp, Utilisateur,
} = models;
const logger = require('../utils/logger.js');
const { envelopperJob } = require('../utils/executerJob.js');
const { supprimerParLots } = require('../utils/supprimerParLots.js');

/**
 * Purge des données personnelles arrivées au terme de leur durée de conservation.
 *
 * RGPD art. 5.1.e (limitation de la conservation) : aucune durée de rétention
 * n'était appliquée nulle part dans le code — seul cleanupExpiredTokens purgeait
 * les jetons expirés. Les journaux de connexion (email, IP, user-agent), le
 * journal d'audit, les notifications et les comptes soft-deleted s'accumulaient
 * indéfiniment, en contradiction avec le cahier des charges (audit 12–36 mois,
 * notifications 12 mois).
 *
 * Durées configurables par variable d'environnement (en MOIS) :
 *   RETENTION_CONNEXION_LOGS_MOIS        défaut 24
 *   RETENTION_AUDIT_LOGS_MOIS            défaut 24, borné à 12–36 (cahier des charges)
 *   RETENTION_NOTIFICATIONS_MOIS         défaut 12
 *   RETENTION_COMPTES_SUPPRIMES_MOIS     défaut 12
 * Une valeur absente, non numérique ou <= 0 retombe sur le défaut (avec un avertissement).
 */

const RETENTIONS = {
  connexionLogs:    { env: 'RETENTION_CONNEXION_LOGS_MOIS',    defaut: 24 },
  auditLogs:        { env: 'RETENTION_AUDIT_LOGS_MOIS',        defaut: 24, min: 12, max: 36 },
  notifications:    { env: 'RETENTION_NOTIFICATIONS_MOIS',     defaut: 12 },
  comptesSupprimes: { env: 'RETENTION_COMPTES_SUPPRIMES_MOIS', defaut: 12 },
};

/** Lit une durée de rétention (en mois) depuis l'environnement, avec bornes. */
function moisDeRetention({ env, defaut, min, max }) {
  const brut = process.env[env];
  let mois = Number.parseInt(brut, 10);

  if (!Number.isInteger(mois) || mois <= 0) {
    if (brut !== undefined) logger.warn(`[job] ${env} invalide ("${brut}") — valeur par défaut ${defaut} mois`);
    mois = defaut;
  }
  if (min !== undefined && mois < min) {
    logger.warn(`[job] ${env}=${mois} sous le minimum réglementaire — ramené à ${min} mois`);
    mois = min;
  }
  if (max !== undefined && mois > max) {
    logger.warn(`[job] ${env}=${mois} au-dessus du maximum autorisé — ramené à ${max} mois`);
    mois = max;
  }
  return mois;
}

/** Date seuil : tout ce qui est antérieur est purgé. */
function seuil(mois) {
  const d = new Date();
  d.setMonth(d.getMonth() - mois);
  return d;
}

/**
 * Pièces du dossier chantier qui ENGAGENT leur auteur. Leur clé vers
 * `utilisateur` est NOT NULL, sans cascade : effacer l'auteur est refusé par
 * la base — et le serait-il, le dossier perdrait sa preuve (qui a constaté,
 * qui a signé). Le compte reste donc, pseudonymisé, comme simple ancrage.
 */
const PIECES_ENGAGEANTES = [
  { modele: 'Reserve', cle: 'creePar' },
  { modele: 'Commentaire', cle: 'utilisateurId' },
  { modele: 'Signature', cle: 'utilisateurId' },
  { modele: 'Convocation', cle: 'utilisateurId' },
];

/** Rattachements techniques sans valeur hors du compte : effacés avec lui. */
const RATTACHEMENTS_TECHNIQUES = ['RefreshToken', 'UserOtp', 'MfaChallenge', 'DeviceToken'];

/**
 * Efface définitivement les comptes supprimés avant `dateSeuil`, sauf ceux
 * qu'une pièce engageante désigne encore.
 *
 * CORRECTIF : l'ancien `Utilisateur.destroy({ force: true })` visait TOUS les
 * comptes du délai d'un seul DELETE. Le premier auteur d'une réserve ou d'un
 * commentaire faisait échouer la contrainte de clé étrangère, donc TOUTE la
 * purge des comptes, chaque semaine — y compris pour les comptes sans aucune
 * pièce. Et les jetons (refresh, appareils) bloquaient de la même façon.
 */
async function effacerComptesSupprimes(dateSeuil) {
  return sequelize.transaction(async (transaction) => {
    const candidats = (await Utilisateur.findAll({
      where: { deletedAt: { [Op.lt]: dateSeuil } },
      paranoid: false, attributes: ['id'], raw: true, transaction,
    })).map((u) => u.id);
    if (!candidats.length) return { effaces: 0, conserves: 0 };

    // `paranoid: false` : une réserve supprimée logiquement garde sa ligne,
    // et sa clé bloque l'effacement tout autant.
    const ancres = new Set();
    for (const { modele, cle } of PIECES_ENGAGEANTES) {
      const lignes = await models[modele].findAll({
        where: { [cle]: { [Op.in]: candidats } },
        attributes: [cle], group: [cle], paranoid: false, raw: true, transaction,
      });
      for (const l of lignes) ancres.add(l[cle]);
    }

    const effacables = candidats.filter((id) => !ancres.has(id));
    if (effacables.length) {
      for (const nom of RATTACHEMENTS_TECHNIQUES) {
        await models[nom].destroy({ where: { utilisateurId: { [Op.in]: effacables } }, transaction });
      }
      // force: true est indispensable — sans lui, Sequelize se contente de
      // réécrire deletedAt sur une ligne déjà soft-deleted.
      await Utilisateur.destroy({ where: { id: { [Op.in]: effacables } }, force: true, transaction });
    }
    return { effaces: effacables.length, conserves: ancres.size };
  });
}

/** L'échec éventuel est journalisé, compté et retenté par `envelopperJob`. */
async function purgerDonneesPersonnelles() {
  const now = new Date();
  const moisConnexions = moisDeRetention(RETENTIONS.connexionLogs);
  const moisAudit = moisDeRetention(RETENTIONS.auditLogs);
  const moisNotifications = moisDeRetention(RETENTIONS.notifications);
  const moisComptes = moisDeRetention(RETENTIONS.comptesSupprimes);

  // Journal des connexions — email, IP et user-agent : les données les plus
  // sensibles de la base après le mot de passe.
  //
  // Ces trois tables sont les plus volumineuses : supprimées PAR LOTS, pour
  // qu'aucun ordre ne dépasse le délai par requête de la base
  // (`statement_timeout`, config/db.js) — voir utils/supprimerParLots.js.
  const connexionLogsSupprimes = await supprimerParLots(ConnexionLog, {
    createdAt: { [Op.lt]: seuil(moisConnexions) },
  });

  // Journal d'audit — traçabilité des actions d'administration.
  const auditLogsSupprimes = await supprimerParLots(AuditLog, {
    createdAt: { [Op.lt]: seuil(moisAudit) },
  });

  // Notifications in-app (titre + message, souvent nominatifs).
  const notificationsSupprimees = await supprimerParLots(Notification, {
    createdAt: { [Op.lt]: seuil(moisNotifications) },
  });

  // Jetons éphémères périmés — filet de sécurité : MfaChallenge n'était purgé
  // par aucun job (cleanupExpiredTokens ne traite que RefreshToken et UserOtp).
  const mfaChallengesSupprimes = await MfaChallenge.destroy({
    where: { expiresAt: { [Op.lt]: now } },
  });
  const otpsSupprimes = await UserOtp.destroy({
    where: { expiresAt: { [Op.lt]: now } },
  });

  // Comptes supprimés (soft delete paranoid) — effacement DÉFINITIF de la ligne
  // au-delà du délai. Le profil a déjà été pseudonymisé au moment de la
  // suppression (AccountService.pseudonymiserEtSupprimer) ; ce délai laisse le
  // temps de restaurer une suppression accidentelle.
  const { effaces: comptesEffacesDefinitivement, conserves: comptesConservesPourLeDossier } =
    await effacerComptesSupprimes(seuil(moisComptes));

  const bilan = {
    connexionLogsSupprimes,
    auditLogsSupprimes,
    notificationsSupprimees,
    mfaChallengesSupprimes,
    otpsSupprimes,
    comptesEffacesDefinitivement,
    comptesConservesPourLeDossier,
  };
  logger.info('[job] Purge des données personnelles (RGPD art. 5.1.e)', {
    ...bilan,
    retentionMois: {
      connexions: moisConnexions,
      audit: moisAudit,
      notifications: moisNotifications,
      comptesSupprimes: moisComptes,
    },
  });
  return bilan;
}

// Même fuseau explicite que les autres jobs : sans lui, « dimanche 03h00 »
// suivait le TZ système (UTC dans le conteneur).
const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

const UNE_SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

const executerPurge = envelopperJob('purge-donnees-personnelles', purgerDonneesPersonnelles, {
  periodeMs: UNE_SEMAINE_MS,
  rattrapage: true,
});

/**
 * Démarre le job — chaque dimanche à 03h00 (fuseau CRON_TZ).
 *
 * CORRECTIF : la tâche n'était pas RENVOYÉE. `server.js` range les tâches
 * pour les arrêter avant de fermer la base ; celle-ci lui échappait, et un
 * déclenchement pendant l'arrêt partait sur un pool en cours de fermeture.
 * @returns {import('node-cron').ScheduledTask}
 */
function startPurgeDonneesPersonnellesJob() {
  const task = cron.schedule('0 3 * * 0', executerPurge, { timezone: CRON_TZ });
  logger.info(`[job] Purge des données personnelles planifiée (chaque dimanche 03h00 ${CRON_TZ})`);
  return task;
}

module.exports = { startPurgeDonneesPersonnellesJob, purgerDonneesPersonnelles, effacerComptesSupprimes };
