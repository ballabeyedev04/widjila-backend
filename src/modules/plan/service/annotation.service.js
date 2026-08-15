'use strict';

const { Annotation, Plan, Chantier, Utilisateur } = require('../../../models/index.js');

/**
 * Annotation — éléments graphiques posés sur un plan (module 4) :
 * marqueurs, dessins, mesures, textes, liens, cercles, rectangles, flèches,
 * ainsi que les repères GPS (latitude / longitude).
 */
class AnnotationService {

  static async creerAnnotation(organisationId, planId, data, creePar) {
    const plan = await Plan.findByPk(planId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const annotation = await Annotation.create({
      planId,
      type: data.type || 'marqueur',
      x: data.x !== undefined ? data.x : null,
      y: data.y !== undefined ? data.y : null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      donnees: data.donnees || null,
      creePar,
    });

    return { success: true, message: 'Annotation ajoutée au plan', annotation };
  }

  static async listAnnotations(organisationId, planId) {
    const plan = await Plan.findByPk(planId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const annotations = await Annotation.findAll({
      where: { planId },
      include: [{ model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }],
      order: [['createdAt', 'ASC']],
    });
    return { success: true, annotations };
  }

  static async modifierAnnotation(organisationId, annotationId, data) {
    const annotation = await Annotation.findByPk(annotationId, {
      include: [{
        model: Plan, as: 'plan',
        include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      }],
    });
    if (!annotation) return { success: false, message: 'Annotation introuvable' };

    const updates = {};
    for (const champ of ['type', 'x', 'y', 'latitude', 'longitude', 'donnees']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    await annotation.update(updates);
    return { success: true, message: 'Annotation mise à jour', annotation };
  }

  static async supprimerAnnotation(organisationId, annotationId) {
    const annotation = await Annotation.findByPk(annotationId, {
      include: [{
        model: Plan, as: 'plan',
        include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      }],
    });
    if (!annotation) return { success: false, message: 'Annotation introuvable' };

    await annotation.destroy(); // soft delete
    return { success: true, message: 'Annotation supprimée' };
  }
}

module.exports = AnnotationService;
