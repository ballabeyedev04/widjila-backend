'use strict';

const InspectionExtraService = require('../service/inspectionExtra.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Convocations et application d'un modèle portent sur une INSPECTION (`:id`),
 * qui tient son organisation de son chantier — voir utils/organisationRequete.js.
 *
 * Les MODÈLES de checklist, eux, appartiennent directement à une organisation
 * (ChecklistModele.organisationId) : ils restent sur `req.user.organisationId`,
 * comme le module organisation. Le super-admin plateforme n'en possède aucun —
 * il gère les organisations, pas leurs bibliothèques de contrôle.
 */
const orgDeInspection = (req) => organisationCible(req, { inspectionId: req.params.id });

// -------------------- MODÈLES DE CHECKLIST --------------------
exports.creerModele = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.creerModele(req.user.organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { modele: result.modele } });
});

exports.listerModeles = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.listModeles(req.user.organisationId);
  res.status(200).json({ success: true, message: 'Modèles récupérés', data: { modeles: result.modeles } });
});

exports.modifierModele = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.modifierModele(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { modele: result.modele } });
});

exports.supprimerModele = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.supprimerModele(req.user.organisationId, req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- CONVOCATIONS --------------------
exports.convier = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.convier(
    await orgDeInspection(req),
    req.params.id,
    req.body.utilisateurId
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { convocation: result.convocation } });
});

exports.listerConvocations = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.listConvocations(await orgDeInspection(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Convocations récupérées', data: { convocations: result.convocations } });
});

exports.repondreConvocation = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.repondreConvocation(
    await orgDeInspection(req),
    req.params.id,
    req.params.convocationId,
    req.body,
    req.user.id,
    req.user.role
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { convocation: result.convocation } });
});

exports.retirerConvocation = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.retirerConvocation(
    await orgDeInspection(req),
    req.params.id,
    req.params.convocationId
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- APPLICATION D'UN MODÈLE --------------------
exports.appliquerModele = asyncHandler(async (req, res) => {
  const result = await InspectionExtraService.appliquerModele(
    await orgDeInspection(req),
    req.params.id,
    req.body.modeleId
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
