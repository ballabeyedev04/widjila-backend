'use strict';

const ReserveExtraService = require('../service/reserveExtra.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Pièces jointes, signatures, affectations et QR portent sur une RÉSERVE
 * (`:id`), qui tient son organisation de son chantier — voir
 * utils/organisationRequete.js. Seule la suppression d'une pièce jointe est
 * adressée par `:pieceId` sans la réserve dans l'URL : la remontée part alors
 * de la pièce.
 */
const orgDeReserve = (req) => organisationCible(req, { reserveId: req.params.id });

// -------------------- PIÈCES JOINTES --------------------
exports.ajouterPieceJointe = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.ajouterPieceJointe(
    await orgDeReserve(req),
    req.params.id,
    req.file,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { piece: result.piece } });
});

exports.listerPiecesJointes = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.listPiecesJointes(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Pièces jointes récupérées', data: { pieces: result.pieces } });
});

exports.supprimerPieceJointe = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.supprimerPieceJointe(await organisationCible(req, { pieceJointeId: req.params.pieceId }), req.params.pieceId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- SIGNATURES --------------------
exports.signerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.signer(
    await orgDeReserve(req),
    req.params.id,
    req.body,
    req.user.id,
    req.user.role
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { signature: result.signature } });
});

exports.listerSignatures = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.listSignatures(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Signatures récupérées', data: { signatures: result.signatures } });
});

// -------------------- AFFECTATIONS MULTIPLES --------------------
exports.affecterIntervenant = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.affecter(
    await orgDeReserve(req),
    req.params.id,
    req.body,
    req.body.date_affectation,
    // Auteur de l'affectation — requis pour l'historisation (« toute
    // modification est historisée avec l'auteur, la date et l'heure »).
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { affectation: result.affectation } });
});

exports.listerAffectations = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.listAffectations(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Affectations récupérées', data: { affectations: result.affectations } });
});

exports.retirerAffectation = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.retirerAffectation(await orgDeReserve(req), req.params.id, req.params.affectationId, req.user.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- QR CODE --------------------
exports.genererQr = asyncHandler(async (req, res) => {
  const result = await ReserveExtraService.genererQr(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'QR code généré', data: { qr: result.qr, url: result.url } });
});
