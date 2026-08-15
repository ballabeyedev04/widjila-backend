'use strict';

const GestionOrganisationService = require('../service/gestionOrganisation.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.listerOrganisations = asyncHandler(async (req, res) => {
  const result = await GestionOrganisationService.listOrganisations(req.query);
  res.status(200).json({
    success: true,
    message: 'Organisations récupérées',
    data: { organisations: result.organisations, total: result.total },
  });
});

exports.detailOrganisation = asyncHandler(async (req, res) => {
  const result = await GestionOrganisationService.getOrganisation(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Organisation récupérée',
    data: { organisation: result.organisation },
  });
});

exports.creerOrganisation = asyncHandler(async (req, res) => {
  const result = await GestionOrganisationService.creerOrganisation(req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { organisation: result.organisation } });
});

exports.modifierOrganisation = asyncHandler(async (req, res) => {
  const result = await GestionOrganisationService.modifierOrganisation(req.params.id, req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { organisation: result.organisation } });
});

exports.supprimerOrganisation = asyncHandler(async (req, res) => {
  const result = await GestionOrganisationService.supprimerOrganisation(req.params.id, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
