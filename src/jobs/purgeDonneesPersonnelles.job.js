'use strict';

const cron = require('node-cron');
const { Op } = require('sequelize');
const {
  ConnexionLog, AuditLog, Notification, MfaChallenge, UserOtp, Utilisateur,
} = require('../models/index.js');
const logger = require('../utils/logger.js');

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

async function purgerDonneesPersonnelles() {
  try {
    const now = new Date();
    const moisConnexions = moisDeRetention(RETENTIONS.connexionLogs);
    const moisAudit = moisDeRetention(RETENTIONS.auditLogs);
    const moisNotifications = moisDeRetention(RETENTIONS.notifications);
    const moisComptes = moisDeRetention(RETENTIONS.comptesSupprimes);

    // Journal des connexions — email, IP et user-agent : les données les plus
    // sensibles de la base après le mot de passe.
    const connexionLogsSupprimes = await ConnexionLog.destroy({
      where: { createdAt: { [Op.lt]: seuil(moisConnexions) } },
    });

    // Journal d'audit — traçabilité des actions d'administration.
    const auditLogsSupprimes = await AuditLog.destroy({
      where: { createdAt: { [Op.lt]: seuil(moisAudit) } },
    });

    // Notifications in-app (titre + message, souvent nominatifs).
    const notificationsSupprimees = await Notification.destroy({
      where: { createdAt: { [Op.lt]: seuil(moisNotifications) } },
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
    // temps de restaurer une suppression accidentelle et de conserver l'intégrité
    // référentielle des réserves/commentaires le temps de la clôture des chantiers.
    // force: true est indispensable — sans lui, Sequelize se contente de
    // réécrire deletedAt sur une ligne déjà soft-deleted.
    const comptesEffacesDefinitivement = await Utilisateur.destroy({
      where: { deletedAt: { [Op.lt]: seuil(moisComptes) } },
      force: true,
    });

    logger.info('[job] Purge des données personnelles (RGPD art. 5.1.e)', {
      connexionLogsSupprimes,
      auditLogsSupprimes,
      notificationsSupprimees,
      mfaChallengesSupprimes,
      otpsSupprimes,
      comptesEffacesDefinitivement,
      retentionMois: {
        connexions: moisConnexions,
        audit: moisAudit,
        notifications: moisNotifications,
        comptesSupprimes: moisComptes,
      },
    });
  } catch (err) {
    logger.error('[job] Échec purge des données personnelles', { error: err.message, stack: err.stack });
  }
}

/** Démarre le job — chaque dimanche à 03h00. */
function startPurgeDonneesPersonnellesJob() {
  cron.schedule('0 3 * * 0', purgerDonneesPersonnelles);
  logger.info('[job] Purge des données personnelles planifiée (chaque dimanche 03h00)');
}

module.exports = { startPurgeDonneesPersonnellesJob, purgerDonneesPersonnelles };
