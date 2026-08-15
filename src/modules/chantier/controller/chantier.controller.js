'use strict';

const ChantierService = require('../service/chantier.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.listerChantiers = asyncHandler(async (req, res) => {
  const result = await ChantierService.listChantiers(req.user.organisationId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Chantiers récupérés',
    data: { chantiers: result.chantiers, total: result.total },
  });
});

exports.creerChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerChantier(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.detailChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.getChantier(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Chantier récupéré', data: { chantier: result.chantier } });
});

exports.modifierChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.modifierChantier(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.changerStatut = asyncHandler(async (req, res) => {
  const result = await ChantierService.changerStatut(req.user.organisationId, req.params.id, req.body.statut);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.supprimerChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.supprimerChantier(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- STRUCTURE --------------------
exports.creerBatiment = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerBatiment(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { batiment: result.batiment } });
});

exports.creerEtage = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerEtage(
    req.user.organisationId,
    req.params.id,
    req.params.batimentId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { etage: result.etage } });
});

exports.creerZone = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerZone(
    req.user.organisationId,
    req.params.id,
    req.params.batimentId,
    req.params.etageId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { zone: result.zone } });
});

exports.creerLot = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerLot(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { lot: result.lot } });
});

exports.listerLots = asyncHandler(async (req, res) => {
  const result = await ChantierService.listLots(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Lots récupérés', data: { lots: result.lots } });
});

// -------------------- AFFECTATION MEMBRES (module 1) --------------------
exports.assignerMembres = asyncHandler(async (req, res) => {
  const result = await ChantierService.assignerMembres(
    req.user.organisationId,
    req.params.id,
    req.body.membreIds,
    req.body.roleChantier
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.listerMembresChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.listMembresChantier(req.user.organisationId, req.params.id, req.user.role);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Membres récupérés', data: { membres: result.membres } });
});

exports.retirerMembreChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.retirerMembreChantier(
    req.user.organisationId,
    req.params.id,
    req.params.membreId
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.listerMesChantiers = asyncHandler(async (req, res) => {
  const result = await ChantierService.listChantiersUtilisateur(req.user.id, req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Mes chantiers récupérés', data: { chantiers: result.chantiers } });
});

// -------------------- MODULE 3 : DUPLICATION / PHASES / CALENDRIER --------------------
exports.dupliquerChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.dupliquerChantier(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.creerPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerPhase(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.listerPhases = asyncHandler(async (req, res) => {
  const result = await ChantierService.listPhases(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Phases récupérées', data: { phases: result.phases } });
});

exports.modifierPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.modifierPhase(req.user.organisationId, req.params.id, req.params.phaseId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.supprimerPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.supprimerPhase(req.user.organisationId, req.params.id, req.params.phaseId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.calendrier = asyncHandler(async (req, res) => {
  const result = await ChantierService.calendrier(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Calendrier récupéré', data: result.calendrier });
});
