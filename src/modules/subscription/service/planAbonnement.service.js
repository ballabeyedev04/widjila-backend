'use strict';

const { UniqueConstraintError } = require('sequelize');
const { PlanAbonnement, AbonnementSouscrit } = require('../../../models/index.js');
const { estConnue } = require('../../../config/fonctionnalites.js');
const { vuePublique } = require('./subscription.service.js');

/**
 * Administration du catalogue des formules — le menu « Prix abonnements ».
 *
 * Réservé au SUPER-ADMIN plateforme : le catalogue est commun à tous les
 * clients, un chef de projet ne doit pas pouvoir modifier le tarif que paient
 * les autres organisations. La garde vit sur la route.
 *
 * ── Ce qui ne peut pas être défait ────────────────────────────────────────
 * Une formule déjà souscrite ne se supprime pas : l'historique y renvoie, et
 * l'effacer réécrirait des transactions passées. On désactive.
 */
class PlanAbonnementService {

  /** Catalogue COMPLET — actives et désactivées — pour l'administration. */
  static async lister() {
    const plans = await PlanAbonnement.findAll({
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
    });
    return { success: true, plans: plans.map(PlanAbonnementService._vueAdmin) };
  }

  static async detail(id) {
    const plan = await PlanAbonnement.findByPk(id);
    if (!plan) return { success: false, message: 'Formule introuvable' };
    return { success: true, plan: PlanAbonnementService._vueAdmin(plan) };
  }

  /**
   * Vue d'administration : la vue publique, plus ce qui ne regarde que
   * l'administrateur (état, identifiant Stripe, dates).
   */
  static _vueAdmin(plan) {
    return {
      ...vuePublique(plan),
      actif: plan.actif,
      stripePriceId: plan.stripe_price_id,
      creeLe: plan.createdAt,
      modifieLe: plan.updatedAt,
    };
  }

  /**
   * Ne retient que les codes de fonctionnalités RECONNUS.
   *
   * Un code inconnu n'ouvrirait rien de toute façon (voir droits.service.js),
   * mais le laisser entrer donnerait l'illusion, dans l'interface
   * d'administration, d'avoir accordé une option qui n'existe pas.
   */
  static _fonctionnalitesValides(liste) {
    if (!Array.isArray(liste)) return undefined;
    return liste.filter((code) => estConnue(code));
  }

  static _collision(err) {
    return err instanceof UniqueConstraintError
      ? 'Une formule porte déjà ce code'
      : null;
  }

  static async creer(data) {
    try {
      const plan = await PlanAbonnement.create({
        code: data.code,
        nom: data.nom,
        description: data.description || null,
        // `null` = sur devis. On distingue explicitement « champ absent » de
        // « prix effacé » : les deux doivent donner NULL, pas 0.
        prix: data.prix === undefined || data.prix === null || data.prix === '' ? null : data.prix,
        devise: data.devise || 'EUR',
        periode: data.periode || 'mois',
        limite_utilisateurs: data.limiteUtilisateurs ?? null,
        limite_chantiers: data.limiteChantiers ?? null,
        fonctionnalites: PlanAbonnementService._fonctionnalitesValides(data.fonctionnalites) || [],
        stripe_price_id: data.stripePriceId || null,
        actif: data.actif ?? true,
        ordre: data.ordre ?? 0,
      });
      return { success: true, message: 'Formule créée', plan: PlanAbonnementService._vueAdmin(plan) };
    } catch (err) {
      const collision = PlanAbonnementService._collision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  static async modifier(id, data) {
    const plan = await PlanAbonnement.findByPk(id);
    if (!plan) return { success: false, message: 'Formule introuvable' };

    const updates = {};
    if (data.nom !== undefined) updates.nom = data.nom;
    if (data.description !== undefined) updates.description = data.description || null;
    if (data.prix !== undefined) updates.prix = data.prix === null || data.prix === '' ? null : data.prix;
    if (data.devise !== undefined) updates.devise = data.devise;
    if (data.periode !== undefined) updates.periode = data.periode;
    if (data.limiteUtilisateurs !== undefined) updates.limite_utilisateurs = data.limiteUtilisateurs;
    if (data.limiteChantiers !== undefined) updates.limite_chantiers = data.limiteChantiers;
    if (data.stripePriceId !== undefined) updates.stripe_price_id = data.stripePriceId || null;
    if (data.actif !== undefined) updates.actif = data.actif;
    if (data.ordre !== undefined) updates.ordre = data.ordre;
    if (data.fonctionnalites !== undefined) {
      updates.fonctionnalites = PlanAbonnementService._fonctionnalitesValides(data.fonctionnalites) || [];
    }

    // Le CODE n'est volontairement pas modifiable : il sert de clé dans
    // l'historique des souscriptions et dans les rapprochements. Le renommer
    // orphelinerait les lignes déjà enregistrées.

    try {
      await plan.update(updates);
      // Changer le prix n'affecte AUCUNE souscription passée : `prix_paye` est
      // figé dans `abonnements_souscrits`. Les abonnés en cours conservent
      // donc leur tarif jusqu'à leur prochain renouvellement.
      return { success: true, message: 'Formule modifiée', plan: PlanAbonnementService._vueAdmin(plan) };
    } catch (err) {
      const collision = PlanAbonnementService._collision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  static async basculerActif(id, actif) {
    const plan = await PlanAbonnement.findByPk(id);
    if (!plan) return { success: false, message: 'Formule introuvable' };

    // Désactiver ne touche à AUCUNE souscription en cours : la formule
    // disparaît des offres proposées, les abonnés actuels la gardent jusqu'à
    // leur échéance.
    await plan.update({ actif });
    return {
      success: true,
      message: actif ? 'Formule activée' : 'Formule désactivée',
      plan: PlanAbonnementService._vueAdmin(plan),
    };
  }

  /**
   * Suppression — REFUSÉE dès qu'une souscription y renvoie.
   *
   * Le geste attendu est la désactivation : supprimer effacerait le lien avec
   * des transactions réelles.
   */
  static async supprimer(id) {
    const plan = await PlanAbonnement.findByPk(id);
    if (!plan) return { success: false, message: 'Formule introuvable' };

    const nb = await AbonnementSouscrit.count({ where: { planAbonnementId: id } });
    if (nb > 0) {
      return {
        success: false,
        message: nb === 1
          ? '1 souscription utilise cette formule. Désactivez-la plutôt que de la supprimer.'
          : `${nb} souscriptions utilisent cette formule. Désactivez-la plutôt que de la supprimer.`,
      };
    }

    await plan.destroy();
    return { success: true, message: 'Formule supprimée' };
  }
}

module.exports = PlanAbonnementService;
