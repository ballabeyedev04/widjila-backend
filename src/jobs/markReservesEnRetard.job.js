'use strict';

const { Op } = require('sequelize');
const cron = require('node-cron');
const { Reserve } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const logger = require('../utils/logger.js');

/**
 * Job — passage automatique des réserves en retard (module 5 / cahier des
 * charges § Gestion automatique du retard).
 *
 * Une réserve est "en retard" lorsque sa date_limite est dépassée alors
 * qu'elle n'est ni validée, ni clôturée, ni refusée. Le statut 'en_retard'
 * est posé directement (hors matrice de transitions — c'est un dérivé).
 */
async function marquerReservesEnRetard() {
  try {
    const maintenant = new Date();

    // Réserves ouvertes dont la date limite est dépassée
    const enRetard = await Reserve.findAll({
      where: {
        date_limite: { [Op.lt]: maintenant },
        statut: { [Op.notIn]: ['validee', 'cloturee', 'refusee', 'en_retard'] },
      },
    });

    if (!enRetard.length) return;

    await Reserve.update(
      { statut: 'en_retard' },
      {
        where: {
          date_limite: { [Op.lt]: maintenant },
          statut: { [Op.notIn]: ['validee', 'cloturee', 'refusee', 'en_retard'] },
        },
      }
    );

    logger.info(`[job] ${enRetard.length} réserve(s) passée(s) en retard`);

    // Notifications aux intervenants concernés (assigné ou créateur)
    for (const r of enRetard) {
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
  } catch (err) {
    logger.error('[job] erreur marquage en retard :', err.message);
  }
}

// CORRECTIF (fuseau horaire des crons non fixé) : sans option `timezone`,
// node-cron se cale sur le TZ système. Dans le conteneur Docker ce TZ est UTC :
// le « 22h00 » annoncé s'exécutait à minuit heure de Paris (23h00 en hiver),
// c'est-à-dire le LENDEMAIN — les réserves échues du jour n'étaient donc pas
// marquées à la bonne date. Fuseau explicite, surchargeable par CRON_TZ.
// API vérifiée sur node-cron 4.6.0 : schedule(expr, fn, { timezone }).
const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

/**
 * Planifie le job (chaque jour à 22h00, fuseau CRON_TZ).
 * @returns {import('node-cron').ScheduledTask} tâche planifiée, à conserver
 *   pour pouvoir l'arrêter lors de l'arrêt propre du serveur (voir server.js).
 */
function startEnRetardJob() {
  const task = cron.schedule('0 22 * * *', marquerReservesEnRetard, { timezone: CRON_TZ });
  logger.info(`[job] Planifié : marquage des réserves en retard (22h00 ${CRON_TZ})`);
  return task;
}

module.exports = { marquerReservesEnRetard, startEnRetardJob };
