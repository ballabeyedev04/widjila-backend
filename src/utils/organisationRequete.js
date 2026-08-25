'use strict';

const { Chantier, Plan, Annotation } = require('../models/index.js');
const { NotFoundError } = require('../errors/AppError.js');

/**
 * Organisation dans laquelle une requête opère.
 *
 * Tous les services filtrent sur `organisationId` (isolation multi-tenant).
 * Pour un utilisateur normal, c'est celle de son compte. Le super-admin
 * plateforme (`role: 'Admin'`) n'appartient à AUCUNE organisation : lui passer
 * son `organisationId` — c'est-à-dire `null` — faisait échouer chaque
 * opération sur une ressource cliente (« chantier introuvable », « plan
 * introuvable », violation de contrainte NOT NULL en création). Il travaille
 * donc dans l'organisation DE LA RESSOURCE visée.
 *
 * Les plans et les annotations n'ont pas d'`organisationId` propre : ils la
 * tiennent de leur chantier, d'où la remontée de chaîne
 * annotation → plan → chantier → organisation.
 *
 * `paranoid: false` : on ne lit ici que l'organisation, pour cadrer l'appel.
 * Une ressource soft-deleted appartient toujours à son propriétaire, et sa
 * suppression définitive doit rester possible.
 */

const estSuperAdmin = (user) => user?.role === 'Admin';

async function organisationDuChantier(chantierId) {
  const chantier = await Chantier.findByPk(chantierId, { attributes: ['organisationId'], paranoid: false });
  if (!chantier) throw new NotFoundError('Chantier introuvable');
  return chantier.organisationId;
}

async function organisationDuPlan(planId) {
  const plan = await Plan.findByPk(planId, { attributes: ['chantierId'], paranoid: false });
  if (!plan) throw new NotFoundError('Plan introuvable');
  return organisationDuChantier(plan.chantierId);
}

async function organisationDeAnnotation(annotationId) {
  const annotation = await Annotation.findByPk(annotationId, { attributes: ['planId'], paranoid: false });
  if (!annotation) throw new NotFoundError('Annotation introuvable');
  return organisationDuPlan(annotation.planId);
}

/**
 * @param {object} req
 * @param {object} cible  Un SEUL identifiant : { chantierId } | { planId } | { annotationId }
 * @returns {Promise<string|null>} organisationId à passer au service
 */
async function organisationCible(req, { chantierId, planId, annotationId } = {}) {
  if (!estSuperAdmin(req.user)) return req.user.organisationId;

  // Déjà chargée par checkOrganisation sur les routes qui l'utilisent :
  // on évite une seconde lecture.
  if (req.resource?.organisationId) return req.resource.organisationId;

  if (chantierId) return organisationDuChantier(chantierId);
  if (planId) return organisationDuPlan(planId);
  if (annotationId) return organisationDeAnnotation(annotationId);

  return req.user.organisationId;
}

module.exports = {
  estSuperAdmin,
  organisationCible,
  organisationDuChantier,
  organisationDuPlan,
  organisationDeAnnotation,
};
