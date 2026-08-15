'use strict';

const { Op } = require('sequelize');
const cron = require('node-cron');
const { Reserve, Chantier, Utilisateur } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const logger = require('../utils/logger.js');

const HORIZON_J3_MS = 3 * 24 * 60 * 60 * 1000; // relance échéance à J-3
const ESCALADE_J7_MS = 7 * 24 * 60 * 60 * 1000; // escalade après 7 j en retard

/**
 * Rappels d'échéances (module 8 / cahier des charges § Rappels) :
 * notifie l'assigné/le créateur d'une réserve dont la date_limite approche
 * (J-3) ou est dépassée (J+0, alerte immédiate) — une seule fois chacun.
 */
async function relancerEcheances() {
  try {
    const maintenant = new Date();
    const j3 = new Date(Date.now() + HORIZON_J3_MS);

    const reserves = await Reserve.findAll({
      where: {
        statut: { [Op.notIn]: ['validee', 'cloturee', 'refusee'] },
        date_limite: {
          [Op.between]: [maintenant, j3], // échéance dans les 3 prochains jours
        },
      },
    });

    for (const r of reserves) {
      const dest = r.assigneA || r.creePar;
      if (!dest) continue;

      const donnees = { reserveId: r.id, type: 'echeance_proche' };
      const deja = await NotificationService.dejaNotifie(dest, 'reserve.echeance_proche', donnees);
      if (deja) continue;

      const jours = Math.max(1, Math.ceil((new Date(r.date_limite) - maintenant) / (24 * 60 * 60 * 1000)));
      await NotificationService.notifier({
        utilisateurId: dest,
        type: 'reserve.echeance_proche',
        titre: 'Échéance proche',
        message: `La réserve ${r.numero} « ${r.titre} » arrive à échéance dans ${jours} jour(s).`,
        donnees,
      });
    }
  } catch (err) {
    logger.error('[job] erreur rappels échéances :', err.message);
  }
}

/**
 * Escalade (module 8 / cahier des charges § Escalade) : une réserve restée
 * 'en_retard' plus de 7 jours remonte au responsable du chantier.
 */
async function escaladerRetards() {
  try {
    const seuil = new Date(Date.now() - ESCALADE_J7_MS);

    const reserves = await Reserve.findAll({
      where: {
        statut: 'en_retard',
        updatedAt: { [Op.lt]: seuil },
      },
      include: [
        { model: Chantier, as: 'chantier', attributes: ['id', 'nom', 'responsableId'] },
      ],
    });

    for (const r of reserves) {
      if (!r.chantier || !r.chantier.responsableId) continue;

      const donnees = { reserveId: r.id, type: 'escalade_j7' };
      const deja = await NotificationService.dejaNotifie(r.chantier.responsableId, 'reserve.escalade', donnees);
      if (deja) continue;

      await NotificationService.notifier({
        utilisateurId: r.chantier.responsableId,
        type: 'reserve.escalade',
        titre: 'Escalade — réserve en retard',
        message: `La réserve ${r.numero} « ${r.titre} » est en retard depuis plus de 7 jours. Action requise.`,
        donnees,
      });
    }
  } catch (err) {
    logger.error('[job] erreur escalade :', err.message);
  }
}

// CORRECTIF (fuseau horaire des crons non fixé) : sans option `timezone`,
// node-cron se cale sur le TZ système. Dans le conteneur Docker ce TZ est UTC :
// le « 07h00 » annoncé partait à 09h00 heure de Paris (08h00 en hiver) — les
// rappels arrivaient en plein milieu de matinée au lieu de la prise de poste.
// Fuseau explicite, surchargeable par CRON_TZ (documenté dans .env.example).
// API vérifiée sur node-cron 4.6.0 : schedule(expr, fn, { timezone }).
const CRON_TZ = process.env.CRON_TZ || 'Europe/Paris';

/**
 * Planifie les deux relances (quotidien à 07h00, fuseau CRON_TZ).
 * @returns {import('node-cron').ScheduledTask} tâche planifiée, à conserver
 *   pour pouvoir l'arrêter lors de l'arrêt propre du serveur (voir server.js).
 */
function startRemindersJob() {
  const task = cron.schedule('0 7 * * *', async () => {
    await relancerEcheances();
    await escaladerRetards();
  }, { timezone: CRON_TZ });
  logger.info(`[job] Planifié : rappels d’échéances et escalade des retards (07h00 ${CRON_TZ})`);
  return task;
}

module.exports = { relancerEcheances, escaladerRetards, startRemindersJob };
