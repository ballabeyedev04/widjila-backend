'use strict';

const cron = require('node-cron');
const { Op } = require('sequelize');
const { RefreshToken, UserOtp } = require('../models/index.js');
const logger = require('../utils/logger.js');

/**
 * Purge des RefreshToken expirés/révoqués et des UserOtp expirés.
 * Ces tables grossissent à chaque login / demande OTP sans purge — elles
 * n'ont aucune autre mécanique de nettoyage dans le code.
 */
async function cleanupExpiredTokens() {
  try {
    const now = new Date();

    const deletedRefreshTokens = await RefreshToken.destroy({
      where: {
        [Op.or]: [
          { expiresAt: { [Op.lt]: now } },
          { revoked: true },
        ],
      },
    });

    const deletedOtps = await UserOtp.destroy({
      where: { expiresAt: { [Op.lt]: now } },
    });

    logger.info('[job] Nettoyage tokens expirés', {
      refreshTokensSupprimés: deletedRefreshTokens,
      otpsSupprimés: deletedOtps,
    });
  } catch (err) {
    logger.error('[job] Échec nettoyage tokens expirés', { error: err.message, stack: err.stack });
  }
}

// CORRECTIF (fuseau horaire des crons non fixé) : sans option `timezone`,
// node-cron se cale sur le TZ système. Dans le conteneur Docker (image
// node:slim, aucun /etc/timezone configuré) ce TZ est UTC : « lundi 00h00 »
// s'exécutait en réalité lundi 02h00 heure de Paris (01h00 en hiver).
// Fuseau explicite, surchargeable par CRON_TZ (documenté dans .env.example).
// API vérifiée sur node-cron 4.6.0 : schedule(expr, fn, { timezone }) et
// l'objet ScheduledTask retourné expose stop()/destroy().
const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

/**
 * Démarre le job — chaque lundi à 00h00 (fuseau CRON_TZ).
 * @returns {import('node-cron').ScheduledTask} tâche planifiée, à conserver
 *   pour pouvoir l'arrêter lors de l'arrêt propre du serveur (voir server.js).
 */
function startCleanupExpiredTokensJob() {
  const task = cron.schedule('0 0 * * 1', cleanupExpiredTokens, { timezone: CRON_TZ });
  logger.info(`[job] Nettoyage tokens expirés planifié (chaque lundi 00h00 ${CRON_TZ})`);
  return task;
}

module.exports = { startCleanupExpiredTokensJob, cleanupExpiredTokens };
