'use strict';

const ReserveService = require('../service/reserve.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.creerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.creerReserve(req.user.organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.listerReserves = asyncHandler(async (req, res) => {
  const result = await ReserveService.listReserves(req.user.organisationId, req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.listerToutesReserves = asyncHandler(async (req, res) => {
  const result = await ReserveService.listToutesReserves(req.user.organisationId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.detailReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.getReserve(req.params.id, req.user.organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Réserve récupérée', data: { reserve: result.reserve } });
});

exports.modifierReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.modifierReserve(req.user.organisationId, req.params.id, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.changerStatut = asyncHandler(async (req, res) => {
  const result = await ReserveService.changerStatut(
    req.user.organisationId,
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
  const result = await ReserveService.supprimerReserve(req.user.organisationId, req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- SÉRIE & DUPLICATION (module 5) --------------------
exports.creerSerieReserves = asyncHandler(async (req, res) => {
  const result = await ReserveService.creerReserveSerie(req.user.organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.dupliquerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.dupliquerReserve(req.user.organisationId, req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

// -------------------- COMMENTAIRES --------------------
exports.ajouterCommentaire = asyncHandler(async (req, res) => {
  const result = await ReserveService.ajouterCommentaire(
    req.user.organisationId,
    req.params.id,
    req.body.message,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { commentaire: result.commentaire } });
});

exports.listerCommentaires = asyncHandler(async (req, res) => {
  const result = await ReserveService.listCommentaires(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Commentaires récupérés',
    data: { commentaires: result.commentaires },
  });
});
