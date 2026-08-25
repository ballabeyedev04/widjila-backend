'use strict';

const RapportService = require('../service/rapport.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Un rapport n'a pas d'`organisationId` : il la tient de son chantier — voir
 * utils/organisationRequete.js. La génération reçoit le chantier dans le corps
 * ou la query (`params.chantierId`), pas dans l'URL.
 */

exports.genererRapport = asyncHandler(async (req, res) => {
  const params = { ...req.body, ...req.query };
  const organisationId = await organisationCible(req, { chantierId: params.chantierId });
  const result = await RapportService.genererRapport(params, req.user.id, organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { rapport: result.rapport } });
});

exports.listerRapports = asyncHandler(async (req, res) => {
  const result = await RapportService.listRapports(await organisationCible(req, { chantierId: req.params.chantierId }), req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Rapports récupérés', data: { rapports: result.rapports } });
});

exports.detailRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.getRapport(req.params.id, await organisationCible(req, { rapportId: req.params.id }));
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Rapport récupéré', data: { rapport: result.rapport } });
});

exports.supprimerRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.supprimerRapport(await organisationCible(req, { rapportId: req.params.id }), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
