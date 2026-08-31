'use strict';

const PlanService = require('../service/plan.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible, estSuperAdmin } = require('../../../utils/organisationRequete.js');

/**
 * Un plan n'a pas d'`organisationId` : il la tient de son chantier — tous les
 * services de ce module filtrent via `include: [{ Chantier, where: { organisationId } }]`.
 * Le super-admin plateforme n'appartenant à aucune organisation, lui passer la
 * sienne (`null`) faisait répondre « chantier introuvable » à chaque dépôt de
 * plan et « plan introuvable » à chaque lecture. Il travaille donc dans
 * l'organisation de la ressource visée — voir utils/organisationRequete.js.
 */

exports.uploaderPlan = asyncHandler(async (req, res) => {
  const data = { ...req.body, uploaderId: req.user.id };
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  // L'auteur vient du JETON : c'est lui qui décide si le dépôt est permis
  // (voir `_refusDepot`), jamais un champ du corps de la requête.
  const result = await PlanService.upload(organisationId, req.params.chantierId, data, req.file, req.user);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.listerPlans = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await PlanService.listPlans(organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Plans récupérés', data: { plans: result.plans } });
});

exports.listerTousPlans = asyncHandler(async (req, res) => {
  // Liste transversale : aucune ressource ne désigne l'organisation. Le
  // super-admin voit donc TOUTES les organisations (filtre facultatif
  // `?organisationId=`), comme pour la liste des chantiers. Le drapeau dérive
  // du RÔLE seul — jamais d'un paramètre client.
  const superAdmin = estSuperAdmin(req.user);
  const result = await PlanService.listTousPlans(
    superAdmin ? (req.query.organisationId || null) : req.user.organisationId,
    req.query,
    { toutesOrganisations: superAdmin }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Plans récupérés', data: { plans: result.plans } });
});

exports.detailPlan = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await PlanService.getPlan(req.params.id, organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Plan récupéré', data: { plan: result.plan } });
});

exports.supprimerPlan = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await PlanService.supprimerPlan(organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
