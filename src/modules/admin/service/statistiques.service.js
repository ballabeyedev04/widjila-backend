'use strict';

const { fn, col, Op } = require('sequelize');
const { Organisation, Utilisateur, Chantier, Reserve, Plan } = require('../../../models/index.js');
const { STATUT_CHANTIER_EN_DEMANDE } = require('../../../config/enums.js');

/** Statut commun a tout ce qui attend une decision. */
const EN_ATTENTE = 'en_attente_validation';

/**
 * Statistiques plateforme — SUPER-ADMIN (rôle 'Admin').
 * Vue globale : organisations, utilisateurs, chantiers, réserves.
 */
class StatistiquesService {

  /**
   * Vue plateforme du super-admin.
   *
   * Deux familles de chiffres, et la distinction n'est pas cosmetique.
   *
   * Les VOLUMES (organisations, utilisateurs, chantiers, reserves) disent
   * l'ampleur du parc. Ils ne demandent rien a personne.
   *
   * Les chiffres de DECISION — inscriptions, chantiers et plans en attente —
   * designent au contraire un travail qui n'a pas ete fait, et dont quelqu'un
   * attend le resultat a l'autre bout. C'est le metier reel de ce compte :
   * il ne cree pas de chantier, il tranche les demandes.
   *
   * Ils manquaient entierement : l'ecran comptait ce qui EXISTE, jamais ce
   * qui ATTEND.
   */
  static async statsPlateforme() {
    const [
      organisations, utilisateurs, chantiers, reserves, parAbonnement, reservesParStatut,
      reservesOuvertes,
      inscriptionsEnAttente, inscriptionsRejetees,
      chantiersEnAttente, chantiersRejetes, chantiersActifs,
      plansEnAttente,
    ] = await Promise.all([
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

      // Ce comptage etait `await`e APRES le Promise.all, donc en serie : un
      // aller-retour de plus vers la base pour rien.
      Reserve.count({ where: { statut: { [Op.notIn]: ['validee', 'cloturee'] } } }),

      // ── Ce qui attend une decision ────────────────────────────────────
      Utilisateur.count({ where: { statut: EN_ATTENTE } }),
      Utilisateur.count({ where: { statut: 'rejete' } }),
      Chantier.count({ where: { statut: EN_ATTENTE } }),
      Chantier.count({ where: { statut: 'rejete' } }),
      // Un chantier ACTIF est un chantier sorti du circuit de demande —
      // ni en attente, ni rejete. C'est la meme regle que la liste des
      // chantiers, pour que les deux ecrans ne divergent pas.
      Chantier.count({ where: { statut: { [Op.notIn]: STATUT_CHANTIER_EN_DEMANDE } } }),
      Plan.count({ where: { statut: EN_ATTENTE } }),
    ]);

    return {
      success: true,
      stats: {
        organisations,
        utilisateurs,
        chantiers,
        reserves,
        reservesOuvertes,
        chantiersActifs,

        // Regroupes plutot qu'eparpilles : l'ecran les presente ensemble,
        // parce qu'ils repondent tous a la meme question — « qu'est-ce qui
        // attend ma decision ? ».
        aValider: {
          inscriptions: inscriptionsEnAttente,
          chantiers: chantiersEnAttente,
          plans: plansEnAttente,
        },
        rejetes: {
          inscriptions: inscriptionsRejetees,
          chantiers: chantiersRejetes,
        },
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
        [fn('to_char', col('created_at'), 'YYYY-MM'), 'mois'],
        [fn('COUNT', col('id')), 'n'],
      ],
      group: ['mois'],
      order: [[fn('to_char', col('created_at'), 'YYYY-MM'), 'ASC']],
      raw: true,
    });

    return { success: true, croissance: rows.map((r) => ({ mois: r.mois, inscriptions: Number(r.n) })) };
  }
}

module.exports = StatistiquesService;
