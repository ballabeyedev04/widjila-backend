'use strict';

const RapportService = require('../service/rapport.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.genererRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.genererRapport({ ...req.body, ...req.query }, req.user.id, req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { rapport: result.rapport } });
});

exports.listerRapports = asyncHandler(async (req, res) => {
  const result = await RapportService.listRapports(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Rapports récupérés', data: { rapports: result.rapports } });
});

exports.detailRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.getRapport(req.params.id, req.user.organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Rapport récupéré', data: { rapport: result.rapport } });
});

exports.supprimerRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.supprimerRapport(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
