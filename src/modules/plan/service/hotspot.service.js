'use strict';

const { PlanHotspot, Plan, Chantier, Batiment, Etage, Zone } = require('../../../models/index.js');

/**
 * Hotspot — zone cliquable posée sur un plan (voir planHotspot.model.js).
 *
 * C'est le maillon qui rend navigable le parcours décrit par le guide client :
 * on clique un bâtiment sur le plan global, l'application descend à ses
 * étages ; on clique un étage, elle descend à ses appartements.
 *
 * La CIBLE est vérifiée à l'écriture (`_verifierCible`) : sans ce contrôle, un
 * hotspot pouvait pointer vers un bâtiment appartenant à un AUTRE chantier —
 * voire à une autre organisation — et la navigation faisait alors fuiter une
 * structure qui n'appartenait pas au consultant.
 */
class HotspotService {

  /**
   * Charge le plan en s'assurant qu'il appartient bien à l'organisation.
   * Toutes les méthodes passent par ici : c'est le point unique d'isolation
   * multi-tenant du module.
   */
  static async _planDeLOrganisation(organisationId, planId) {
    return Plan.findByPk(planId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'] }],
    });
  }

  /**
   * Vérifie que la cible existe ET qu'elle appartient au chantier du plan.
   *
   * La remontée diffère selon le niveau visé :
   *   - bâtiment : porte directement `chantierId` ;
   *   - étage    : passe par son bâtiment ;
   *   - zone     : passe par son étage puis son bâtiment.
   *
   * @returns {Promise<string|null>} le nom de la cible, ou null si elle est
   *   introuvable dans ce chantier.
   */
  static async _verifierCible(chantierId, cibleType, cibleId) {
    if (cibleType === 'batiment') {
      const batiment = await Batiment.findOne({ where: { id: cibleId, chantierId }, attributes: ['id', 'nom'] });
      return batiment ? batiment.nom : null;
    }

    if (cibleType === 'etage') {
      const etage = await Etage.findByPk(cibleId, {
        attributes: ['id', 'nom'],
        include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true }],
      });
      return etage ? etage.nom : null;
    }

    // zone
    const zone = await Zone.findByPk(cibleId, {
      attributes: ['id', 'nom'],
      include: [{
        model: Etage, as: 'etage', attributes: ['id'], required: true,
        include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true }],
      }],
    });
    return zone ? zone.nom : null;
  }

  static async lister(organisationId, planId) {
    const plan = await this._planDeLOrganisation(organisationId, planId);
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const hotspots = await PlanHotspot.findAll({
      where: { planId },
      order: [['createdAt', 'ASC']],
    });
    return { success: true, hotspots };
  }

  static async creer(organisationId, planId, data) {
    const plan = await this._planDeLOrganisation(organisationId, planId);
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const nomCible = await this._verifierCible(plan.chantierId, data.cible_type, data.cible_id);
    if (!nomCible) {
      return { success: false, message: 'La cible du repère n’appartient pas à ce chantier' };
    }

    const hotspot = await PlanHotspot.create({
      planId,
      cible_type: data.cible_type,
      cible_id: data.cible_id,
      // À défaut de libellé saisi, on reprend le nom de la cible : la pastille
      // affiche « BÂTIMENT A » sans que personne ait eu à le retaper.
      libelle: data.libelle || nomCible,
      x: data.x,
      y: data.y,
      largeur: data.largeur ?? 0,
      hauteur: data.hauteur ?? 0,
      page: data.page ?? 1,
    });

    return { success: true, message: 'Repère ajouté au plan', hotspot };
  }

  static async modifier(organisationId, hotspotId, data) {
    const hotspot = await PlanHotspot.findByPk(hotspotId, {
      include: [{
        model: Plan, as: 'plan', required: true, attributes: ['id', 'chantierId'],
        include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'], required: true }],
      }],
    });
    if (!hotspot) return { success: false, message: 'Repère introuvable' };

    // Un changement de cible se revérifie : on ne fait pas confiance à la
    // cohérence d'une cible déjà en base pour valider la nouvelle.
    const cibleType = data.cible_type ?? hotspot.cible_type;
    const cibleId = data.cible_id ?? hotspot.cible_id;
    if (data.cible_type !== undefined || data.cible_id !== undefined) {
      const nomCible = await this._verifierCible(hotspot.plan.chantierId, cibleType, cibleId);
      if (!nomCible) {
        return { success: false, message: 'La cible du repère n’appartient pas à ce chantier' };
      }
    }

    const updates = {};
    for (const champ of ['cible_type', 'cible_id', 'libelle', 'x', 'y', 'largeur', 'hauteur', 'page']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    await hotspot.update(updates);

    return { success: true, message: 'Repère mis à jour', hotspot };
  }

  static async supprimer(organisationId, hotspotId) {
    const hotspot = await PlanHotspot.findByPk(hotspotId, {
      include: [{
        model: Plan, as: 'plan', required: true, attributes: ['id'],
        include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'], required: true }],
      }],
    });
    if (!hotspot) return { success: false, message: 'Repère introuvable' };

    await hotspot.destroy();
    return { success: true, message: 'Repère supprimé' };
  }
}

module.exports = HotspotService;
