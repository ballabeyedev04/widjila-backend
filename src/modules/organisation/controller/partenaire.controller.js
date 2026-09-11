'use strict';

const PartenaireService = require('../service/partenaire.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

// `organisationCible` : même cloisonnement des chantiers que le reste de
// l'API. L'annuaire d'un chantier caché (noms, courriels, téléphones des
// entreprises) restait lisible — et enrichissable — par tout membre de
// l'organisation qui en connaissait l'identifiant.
exports.creerPartenaire = asyncHandler(async (req, res) => {
  const data = { ...req.body, chantierId: req.body.chantierId || req.params.chantierId };
  const organisationId = await organisationCible(req, { chantierId: data.chantierId });
  const result = await PartenaireService.creerPartenaire(organisationId, data);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { partenaire: result.partenaire } });
});

exports.listerPartenaires = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await PartenaireService.listPartenaires(organisationId, req.params.chantierId, req.query);
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
