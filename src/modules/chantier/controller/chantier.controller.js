'use strict';

const ChantierService = require('../service/chantier.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../../errors/AppError.js');
const { organisationCible, estSuperAdmin } = require('../../../utils/organisationRequete.js');

/**
 * Organisation dans laquelle la requête opère. Ici la ressource visée est
 * toujours le chantier porté par `:id` — voir utils/organisationRequete.js
 * pour le pourquoi (le super-admin plateforme n'a pas d'organisation propre).
 */
const orgDuChantier = (req) => organisationCible(req, { chantierId: req.params.id });

exports.listerChantiers = asyncHandler(async (req, res) => {
  // Le super-admin plateforme voit le portefeuille de toutes les organisations,
  // avec `?organisationId=` comme filtre facultatif. Le drapeau dérive du RÔLE
  // seul — jamais d'un paramètre client, qui ouvrirait la lecture inter-clients.
  const superAdmin = estSuperAdmin(req.user);
  const result = await ChantierService.listChantiers(
    superAdmin ? (req.query.organisationId || null) : req.user.organisationId,
    req.query,
    { toutesOrganisations: superAdmin }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Chantiers récupérés',
    data: { chantiers: result.chantiers, total: result.total },
  });
});

exports.creerChantier = asyncHandler(async (req, res) => {
  // Un chantier appartient TOUJOURS à une organisation — c'est elle qui en
  // détermine la visibilité pour tous les autres écrans. Le super-admin
  // plateforme n'en ayant pas, il désigne la destination dans le corps de la
  // requête ; pour tout autre rôle le champ est ignoré (et refusé s'il
  // désigne une autre organisation, ce qui reviendrait à écrire chez un
  // client tiers).
  let organisationId = req.user.organisationId;
  if (estSuperAdmin(req.user)) {
    if (!req.body.organisationId) {
      throw new BadRequestError("Sélectionnez l'organisation à laquelle rattacher ce chantier.");
    }
    organisationId = req.body.organisationId;
  } else if (req.body.organisationId && String(req.body.organisationId) !== String(organisationId)) {
    throw new ForbiddenError('Vous ne pouvez créer un chantier que dans votre propre organisation.');
  }

  const result = await ChantierService.creerChantier(organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.detailChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.getChantier(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Chantier récupéré', data: { chantier: result.chantier } });
});

exports.modifierChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.modifierChantier(await orgDuChantier(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.changerStatut = asyncHandler(async (req, res) => {
  const result = await ChantierService.changerStatut(await orgDuChantier(req), req.params.id, req.body.statut);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.supprimerChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.supprimerChantier(await orgDuChantier(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- STRUCTURE --------------------
exports.creerBatiment = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerBatiment(await orgDuChantier(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { batiment: result.batiment } });
});

exports.creerEtage = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerEtage(
    await orgDuChantier(req),
    req.params.id,
    req.params.batimentId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { etage: result.etage } });
});

exports.creerZone = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerZone(
    await orgDuChantier(req),
    req.params.id,
    req.params.batimentId,
    req.params.etageId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { zone: result.zone } });
});

exports.creerLot = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerLot(await orgDuChantier(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { lot: result.lot } });
});

exports.listerLots = asyncHandler(async (req, res) => {
  const result = await ChantierService.listLots(await orgDuChantier(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Lots récupérés', data: { lots: result.lots } });
});

// -------------------- AFFECTATION MEMBRES (module 1) --------------------
exports.assignerMembres = asyncHandler(async (req, res) => {
  const result = await ChantierService.assignerMembres(
    await orgDuChantier(req),
    req.params.id,
    req.body.membreIds,
    req.body.roleChantier
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.listerMembresChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.listMembresChantier(await orgDuChantier(req), req.params.id, req.user.role);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Membres récupérés', data: { membres: result.membres } });
});

exports.retirerMembreChantier = asyncHandler(async (req, res) => {
  const result = await ChantierService.retirerMembreChantier(
    await orgDuChantier(req),
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
  const result = await ChantierService.dupliquerChantier(await orgDuChantier(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { chantier: result.chantier } });
});

exports.creerPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.creerPhase(await orgDuChantier(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.listerPhases = asyncHandler(async (req, res) => {
  const result = await ChantierService.listPhases(await orgDuChantier(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Phases récupérées', data: { phases: result.phases } });
});

exports.modifierPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.modifierPhase(await orgDuChantier(req), req.params.id, req.params.phaseId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.supprimerPhase = asyncHandler(async (req, res) => {
  const result = await ChantierService.supprimerPhase(await orgDuChantier(req), req.params.id, req.params.phaseId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.calendrier = asyncHandler(async (req, res) => {
  const result = await ChantierService.calendrier(await orgDuChantier(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Calendrier récupéré', data: result.calendrier });
});
