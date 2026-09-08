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

exports.listerPlansRacines = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await PlanService.listPlansRacines(organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Plans globaux récupérés', data: { plans: result.plans } });
});

exports.listerSousPlans = asyncHandler(async (req, res) => {
  // L'organisation vient du PLAN appelé, pas d'un paramètre : c'est le service
  // qui remonte au chantier et vérifie l'appartenance.
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await PlanService.listSousPlans(organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Sous-plans récupérés',
    data: { sousPlans: result.sousPlans },
  });
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

/**
 * `POST /plans/:id/versions` — cahier technique § 11 et § 15.
 *
 * Déposer une NOUVELLE VERSION d'un plan existant. Le nom, le chantier et le
 * rattachement sont repris du plan appelé : c'est la définition même d'une
 * version — le même plan, un fichier plus récent.
 *
 * ── Pourquoi une route dédiée alors que l'upload versionne déjà ───────────
 *
 * `POST /chantiers/:id/plans` crée bien la version suivante quand le NOM
 * coïncide. Mais cela suppose que l'appelant connaisse et réécrive exactement
 * le nom, à la casse et à l'espace près : une faute de frappe ne produit pas
 * une erreur, elle crée un SECOND plan qui ressemble au premier. Personne ne
 * s'en aperçoit avant que la liste n'affiche deux entrées presque identiques.
 *
 * En désignant le plan par son identifiant, l'ambiguïté disparaît.
 *
 * La discipline et la date, elles, peuvent changer d'une version à l'autre :
 * elles restent acceptées dans le corps.
 */
exports.deposerVersion = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });

  const precedent = await PlanService.getPlanPourVersion(organisationId, req.params.id);
  if (!precedent.success) throw new NotFoundError(precedent.message);

  const plan = precedent.plan;
  const result = await PlanService.upload(
    organisationId,
    plan.chantierId,
    {
      // Le NOM fait la version : il est repris du plan désigné, jamais du
      // corps de la requête.
      nom: plan.nom,
      batimentId: plan.batimentId,
      etageId: plan.etageId,
      zoneId: plan.zoneId,
      parentId: plan.parentId,
      // Ceux-ci peuvent évoluer : un plan d'architecture peut être redéposé
      // avec une date plus récente, voire une discipline corrigée.
      format: req.body.format,
      type_plan: req.body.type_plan !== undefined ? req.body.type_plan : plan.type_plan,
      date_plan: req.body.date_plan,
      uploaderId: req.user.id,
    },
    req.file,
    req.user,
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.listerReservesDuPlan = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await PlanService.listReservesDuPlan(organisationId, req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves du plan récupérées',
    data: { reserves: result.reserves },
  });
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
