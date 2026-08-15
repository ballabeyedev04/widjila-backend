'use strict';

const OrganisationService = require('../service/organisation.service.js');
const formatUser = require('../../../utils/formatUser.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.monOrganisation = asyncHandler(async (req, res) => {
  const result = await OrganisationService.getOrganisation(req.user.organisationId, req.user.role);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Organisation récupérée',
    data: { organisation: result.organisation },
  });
});

// -------------------- FILIALES & AGENCES (module 2) --------------------
exports.creerFiliale = asyncHandler(async (req, res) => {
  const result = await OrganisationService.creerFiliale(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { filiale: result.filiale } });
});

exports.creerAgence = asyncHandler(async (req, res) => {
  const result = await OrganisationService.creerAgence(req.user.organisationId, req.params.filialeId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { agence: result.agence } });
});

exports.listerFiliales = asyncHandler(async (req, res) => {
  const result = await OrganisationService.listFiliales(req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Filiales récupérées', data: { filiales: result.filiales } });
});

exports.organigramme = asyncHandler(async (req, res) => {
  const result = await OrganisationService.organigramme(req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Organigramme récupéré', data: result.organigramme });
});

exports.importContacts = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    throw new BadRequestError('Fichier CSV manquant');
  }
  const result = await OrganisationService.importContacts(
    req.user.organisationId,
    req.file.buffer,
    req.body.role || 'Client'
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { results: result.results } });
});

exports.modifierOrganisation = asyncHandler(async (req, res) => {
  const result = await OrganisationService.modifierOrganisation(req.user.organisationId, req.body, req.files || {});
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { organisation: result.organisation } });
});

// -------------------- MEMBRES --------------------
exports.listerMembres = asyncHandler(async (req, res) => {
  const result = await OrganisationService.listMembres(req.user.organisationId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Membres récupérés',
    data: { membres: result.membres, total: result.total },
  });
});

exports.ajouterMembre = asyncHandler(async (req, res) => {
  const result = await OrganisationService.ajouterMembre(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: {
      utilisateur: formatUser(result.utilisateur),
      // Renvoyé UNE SEULE FOIS — à communiquer au membre par un canal sûr
      motDePasseTemporaire: result.motDePasseTemporaire,
    },
  });
});

exports.modifierMembre = asyncHandler(async (req, res) => {
  const result = await OrganisationService.modifierMembre(
    req.user.organisationId,
    req.params.id,
    req.body,
    req.user.id // acteur — empêche l'auto-promotion / auto-modification sensible
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.supprimerMembre = asyncHandler(async (req, res) => {
  const result = await OrganisationService.supprimerMembre(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- ÉQUIPES --------------------
exports.creerEquipe = asyncHandler(async (req, res) => {
  const result = await OrganisationService.creerEquipe(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { equipe: result.equipe } });
});

exports.listerEquipes = asyncHandler(async (req, res) => {
  const result = await OrganisationService.listEquipes(req.user.organisationId, req.user.role);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Équipes récupérées', data: { equipes: result.equipes } });
});

exports.ajouterMembreEquipe = asyncHandler(async (req, res) => {
  const result = await OrganisationService.ajouterMembreEquipe(
    req.user.organisationId,
    req.params.id,
    req.body.membreIds
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.retirerMembreEquipe = asyncHandler(async (req, res) => {
  const result = await OrganisationService.retirerMembreEquipe(
    req.user.organisationId,
    req.params.id,
    req.params.membreId
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.supprimerEquipe = asyncHandler(async (req, res) => {
  const result = await OrganisationService.supprimerEquipe(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
