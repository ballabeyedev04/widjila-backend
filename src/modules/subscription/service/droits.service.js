'use strict';

const { Op } = require('sequelize');
const {
  Organisation, PlanAbonnement, AbonnementSouscrit, Utilisateur, Chantier,
} = require('../../../models/index.js');

/**
 * Droits d'une organisation — LE point unique qui répond aux quatre questions :
 *
 *   Quelle est la formule de cette organisation ?
 *   Quelles fonctionnalités ouvre-t-elle ?
 *   Quelles limites impose-t-elle ?
 *   Cette action est-elle permise ?
 *
 * ── Pourquoi centraliser ──────────────────────────────────────────────────
 * Les règles d'abonnement dispersées dans les contrôleurs divergent
 * immanquablement : une limite appliquée à la création d'un membre mais pas à
 * l'import CSV, une fonctionnalité fermée sur le web et ouverte sur le mobile.
 * Tout passe donc par ici, et les middlewares ne font que l'appeler.
 *
 * ── Ce service fait autorité, pas le client ───────────────────────────────
 * Le web et le mobile peuvent masquer un bouton pour le confort, mais
 * n'établissent jamais un droit. Un appel direct à l'API sans passer par
 * l'interface se heurte aux mêmes contrôles.
 */

/** Une organisation en essai a TOUT, le temps de l'essai. */
const CODE_ESSAI = '__essai__';

class DroitsService {

  /**
   * Souscription ACTIVE d'une organisation, la plus récente d'abord.
   *
   * `date_fin` nulle = pas d'échéance connue (formule activée à la main par
   * l'administrateur, par exemple) : on ne la considère pas expirée pour
   * autant, sans quoi une activation manuelle serait morte à la seconde.
   */
  static async souscriptionActive(organisationId) {
    const maintenant = new Date();
    return AbonnementSouscrit.findOne({
      where: {
        organisationId,
        statut: 'active',
        [Op.or]: [{ date_fin: null }, { date_fin: { [Op.gt]: maintenant } }],
      },
      include: [{ model: PlanAbonnement, as: 'plan', required: false }],
      order: [['createdAt', 'DESC']],
    });
  }

  /**
   * Droits effectifs d'une organisation.
   *
   * Trois situations, dans cet ordre de priorité :
   *   1. une souscription active → les droits de sa formule ;
   *   2. sinon, un essai en cours → TOUT est ouvert, sans limite de
   *      fonctionnalité (les limites de volume restent celles de l'essai :
   *      aucune, faute d'indication du client) ;
   *   3. sinon → aucun droit.
   *
   * @returns {Promise<{actif, source, planCode, planNom, fonctionnalites,
   *   limiteUtilisateurs, limiteChantiers, essaiEnCours, dateFin}>}
   */
  static async getDroits(organisationId) {
    const aucun = {
      actif: false,
      source: 'aucun',
      planCode: null,
      planNom: null,
      fonctionnalites: [],
      limiteUtilisateurs: 0,
      limiteChantiers: 0,
      essaiEnCours: false,
      dateFin: null,
    };

    if (!organisationId) return aucun;

    const organisation = await Organisation.findByPk(organisationId, {
      attributes: ['id', 'trial_ends_at', 'is_subscribed'],
    });
    if (!organisation) return aucun;

    const souscription = await DroitsService.souscriptionActive(organisationId);
    if (souscription) {
      const plan = souscription.plan;
      return {
        actif: true,
        source: 'abonnement',
        planCode: souscription.plan_code,
        planNom: souscription.plan_nom,
        // Les fonctionnalités viennent du CATALOGUE COURANT et non de
        // l'instantané : si l'administrateur ouvre une option à Pro, tous les
        // abonnés Pro en bénéficient immédiatement. Seul le PRIX est figé
        // dans l'historique — c'est lui qui engage, pas le périmètre.
        fonctionnalites: Array.isArray(plan?.fonctionnalites) ? plan.fonctionnalites : [],
        limiteUtilisateurs: plan ? plan.limite_utilisateurs : null,
        limiteChantiers: plan ? plan.limite_chantiers : null,
        essaiEnCours: false,
        dateFin: souscription.date_fin,
      };
    }

    // Essai en cours — `trial_ends_at` nul compte comme essai TERMINÉ : voir
    // le correctif documenté dans organisation.model.js, une valeur nulle
    // donnait un accès gratuit permanent.
    const essaiEnCours = !!organisation.trial_ends_at
      && new Date(organisation.trial_ends_at) > new Date();

    if (essaiEnCours) {
      return {
        actif: true,
        source: 'essai',
        planCode: CODE_ESSAI,
        planNom: 'Essai gratuit',
        // Tout est ouvert pendant l'essai : c'est ce qui permet d'évaluer le
        // produit. Aucun document client ne restreint l'essai.
        fonctionnalites: null, // null = toutes
        limiteUtilisateurs: null,
        limiteChantiers: null,
        essaiEnCours: true,
        dateFin: organisation.trial_ends_at,
      };
    }

    return aucun;
  }

  /**
   * Vrai si l'organisation peut utiliser cette fonctionnalité.
   *
   * `fonctionnalites === null` signifie « toutes » (essai) — un tableau vide,
   * lui, signifie « aucune ». Les confondre ouvrirait tout aux organisations
   * sans droits.
   */
  static async peutUtiliser(organisationId, fonctionnalite) {
    const droits = await DroitsService.getDroits(organisationId);
    if (!droits.actif) return { autorise: false, droits, raison: 'SUBSCRIPTION_REQUIRED' };
    if (droits.fonctionnalites === null) return { autorise: true, droits };
    if (droits.fonctionnalites.includes(fonctionnalite)) return { autorise: true, droits };
    return { autorise: false, droits, raison: 'SUBSCRIPTION_FEATURE_UNAVAILABLE' };
  }

  /** Compte courant, pour les deux ressources plafonnées par les formules. */
  static async _compter(ressource, organisationId) {
    if (ressource === 'utilisateurs') {
      // Les comptes désactivés ne consomment pas de siège : la présentation
      // commerciale parle d'« utilisateurs ACTIFS ».
      return Utilisateur.count({ where: { organisationId, statut: 'actif' } });
    }
    return Chantier.count({ where: { organisationId } });
  }

  /**
   * Vérifie qu'une limite n'est pas atteinte AVANT de créer la ressource.
   *
   * @param {number} [aAjouter=1] Nombre d'éléments que l'appel va créer —
   *   l'import de contacts en ajoute plusieurs d'un coup, et vérifier
   *   « 1 de plus » laisserait dépasser le plafond en une seule requête.
   */
  static async verifierLimite(organisationId, ressource, aAjouter = 1) {
    const droits = await DroitsService.getDroits(organisationId);
    if (!droits.actif) return { autorise: false, droits, raison: 'SUBSCRIPTION_REQUIRED' };

    const limite = ressource === 'utilisateurs' ? droits.limiteUtilisateurs : droits.limiteChantiers;
    // null = illimité (voir planAbonnement.model.js) : on ne compte même pas.
    if (limite === null || limite === undefined) return { autorise: true, droits };

    const courant = await DroitsService._compter(ressource, organisationId);
    if (courant + aAjouter > limite) {
      return {
        autorise: false,
        droits,
        raison: 'SUBSCRIPTION_LIMIT_REACHED',
        limite,
        courant,
      };
    }
    return { autorise: true, droits, limite, courant };
  }

  /**
   * Usage courant face aux limites — alimente l'affichage « 4 / 5
   * utilisateurs » et prévient AVANT le refus.
   */
  static async getUsage(organisationId) {
    const droits = await DroitsService.getDroits(organisationId);
    const [utilisateurs, chantiers] = await Promise.all([
      DroitsService._compter('utilisateurs', organisationId),
      DroitsService._compter('chantiers', organisationId),
    ]);

    return {
      droits,
      utilisateurs: { courant: utilisateurs, limite: droits.limiteUtilisateurs },
      chantiers: { courant: chantiers, limite: droits.limiteChantiers },
    };
  }
}

module.exports = DroitsService;
module.exports.CODE_ESSAI = CODE_ESSAI;
