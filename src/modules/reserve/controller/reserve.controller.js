'use strict';

const ReserveService = require('../service/reserve.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible, estSuperAdmin } = require('../../../utils/organisationRequete.js');
// Le plan sert à DÉDUIRE le chantier d'une réserve créée depuis lui
// (`creerReserveSurPlan`) ; le chantier porte le cloisonnement multi-tenant.
const { Plan, Chantier } = require('../../../models/index.js');

/**
 * Une réserve n'a pas d'`organisationId` : elle la tient de son chantier —
 * voir utils/organisationRequete.js. À la création, le chantier arrive dans le
 * corps de la requête ; ailleurs, `:id` désigne la réserve.
 */
const orgDeReserve = (req) => organisationCible(req, { reserveId: req.params.id });

exports.creerReserve = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.body.chantierId });
  const result = await ReserveService.creerReserve(organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.listerReserves = asyncHandler(async (req, res) => {
  const result = await ReserveService.listReserves(await organisationCible(req, { chantierId: req.params.chantierId }), req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

/**
 * `POST /plans/:id/reserves` — cahier technique § 11 et § 12.
 *
 * Le document décrit la création d'une réserve DEPUIS UN PLAN, avec un corps
 * qui ne porte que l'observation, l'entreprise, la gravité, l'échéance et les
 * coordonnées — pas de `chantierId`. C'est cohérent : quand on relève un
 * défaut, on est sur un plan, et le plan sait à quel chantier il appartient.
 *
 * Le chantier est donc DÉDUIT du plan, jamais lu dans le corps de la requête.
 * Un `chantierId` envoyé à côté serait au mieux redondant, au pire
 * contradictoire — et arbitrer entre les deux plus tard serait impossible.
 *
 * Le reste — validation, contrôles d'appartenance, numérotation, position,
 * historique — passe par le MÊME service que `POST /chantiers/:id/reserves`.
 * Deux chemins d'écriture pour un même objet finiraient par diverger.
 */
exports.creerReserveSurPlan = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });

  const plan = await Plan.findOne({
    where: { id: req.params.id },
    attributes: ['id', 'chantierId'],
    include: [{ model: Chantier, as: 'chantier', attributes: ['id'], where: { organisationId }, required: true }],
  });
  if (!plan) throw new NotFoundError('Plan introuvable dans cette organisation');

  const result = await ReserveService.creerReserve(
    organisationId,
    { ...req.body, chantierId: plan.chantierId, planId: plan.id },
    req.user.id,
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.listerToutesReserves = asyncHandler(async (req, res) => {
  // Liste transversale (tous chantiers) : rien dans l'URL ne désigne
  // l'organisation. Le super-admin voit donc toutes les organisations, avec
  // `?organisationId=` en filtre facultatif — même règle que la liste des
  // chantiers et celle des plans. Le drapeau dérive du RÔLE seul.
  const superAdmin = estSuperAdmin(req.user);
  const result = await ReserveService.listToutesReserves(
    superAdmin ? (req.query.organisationId || null) : req.user.organisationId,
    req.query,
    { toutesOrganisations: superAdmin },
    // Cloisonnement par chantier : l'appelant ne liste que les réserves des
    // chantiers qu'il peut ouvrir (ChantierService.filtreCloisonnement).
    req.user
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.detailReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.getReserve(req.params.id, await orgDeReserve(req));
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Réserve récupérée', data: { reserve: result.reserve } });
});

exports.modifierReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.modifierReserve(await orgDeReserve(req), req.params.id, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.changerStatut = asyncHandler(async (req, res) => {
  const result = await ReserveService.changerStatut(
    await orgDeReserve(req),
    req.params.id,
    req.body.statut,
    req.body,
    req.user.id,
    req.user.role
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.supprimerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.supprimerReserve(await orgDeReserve(req), req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- SÉRIE & DUPLICATION (module 5) --------------------
exports.creerSerieReserves = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.body.chantierId });
  const result = await ReserveService.creerReserveSerie(organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.dupliquerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.dupliquerReserve(await orgDeReserve(req), req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

// -------------------- COMMENTAIRES --------------------
exports.ajouterCommentaire = asyncHandler(async (req, res) => {
  const result = await ReserveService.ajouterCommentaire(
    await orgDeReserve(req),
    req.params.id,
    req.body.message,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { commentaire: result.commentaire } });
});

exports.listerCommentaires = asyncHandler(async (req, res) => {
  const result = await ReserveService.listCommentaires(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Commentaires récupérés',
    data: { commentaires: result.commentaires },
  });
});
