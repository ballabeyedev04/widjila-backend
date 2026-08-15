'use strict';

const { fn, col, Op } = require('sequelize');
const { Organisation, Utilisateur, Chantier, Reserve } = require('../../../models/index.js');

/**
 * Statistiques plateforme — SUPER-ADMIN (rôle 'Admin').
 * Vue globale : organisations, utilisateurs, chantiers, réserves.
 */
class StatistiquesService {

  static async statsPlateforme() {
    const [organisations, utilisateurs, chantiers, reserves, parAbonnement, reservesParStatut] = await Promise.all([
      Organisation.count(),
      Utilisateur.count(),
      Chantier.count(),
      Reserve.count(),
      Organisation.findAll({
        attributes: ['abonnement', [fn('COUNT', col('id')), 'n']],
        group: ['abonnement'],
        raw: true,
      }),
      Reserve.findAll({
        attributes: ['statut', [fn('COUNT', col('id')), 'n']],
        group: ['statut'],
        raw: true,
      }),
    ]);

    return {
      success: true,
      stats: {
        organisations,
        utilisateurs,
        chantiers,
        reserves,
        reservesOuvertes: await Reserve.count({
          where: { statut: { [Op.notIn]: ['validee', 'cloturee'] } },
        }),
        parAbonnement: Object.fromEntries(parAbonnement.map((r) => [r.abonnement, Number(r.n)])),
        reservesParStatut: Object.fromEntries(reservesParStatut.map((r) => [r.statut, Number(r.n)])),
      },
    };
  }

  // Croissance des inscriptions sur les N derniers mois (par mois)
  static async croissanceInscriptions(mois = 6) {
    const debut = new Date();
    debut.setMonth(debut.getMonth() - (mois - 1));
    debut.setDate(1);

    const rows = await Utilisateur.findAll({
      where: { createdAt: { [Op.gte]: debut } },
      attributes: [
        [fn('to_char', col('createdAt'), 'YYYY-MM'), 'mois'],
        [fn('COUNT', col('id')), 'n'],
      ],
      group: ['mois'],
      order: [[fn('to_char', col('createdAt'), 'YYYY-MM'), 'ASC']],
      raw: true,
    });

    return { success: true, croissance: rows.map((r) => ({ mois: r.mois, inscriptions: Number(r.n) })) };
  }
}

module.exports = StatistiquesService;
