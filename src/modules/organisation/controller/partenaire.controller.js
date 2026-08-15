'use strict';

const PartenaireService = require('../service/partenaire.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');

exports.creerPartenaire = asyncHandler(async (req, res) => {
  const data = { ...req.body, chantierId: req.body.chantierId || req.params.chantierId };
  const result = await PartenaireService.creerPartenaire(req.user.organisationId, data);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { partenaire: result.partenaire } });
});

exports.listerPartenaires = asyncHandler(async (req, res) => {
  const result = await PartenaireService.listPartenaires(req.user.organisationId, req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Partenaires récupérés',
    data: { partenaires: result.partenaires },
  });
});

exports.modifierPartenaire = asyncHandler(async (req, res) => {
  const result = await PartenaireService.modifierPartenaire(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { partenaire: result.partenaire } });
});

exports.supprimerPartenaire = asyncHandler(async (req, res) => {
  const result = await PartenaireService.supprimerPartenaire(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
