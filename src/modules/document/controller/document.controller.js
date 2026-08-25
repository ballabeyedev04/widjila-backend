'use strict';

const DocumentService = require('../service/document.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Un document n'a pas d'`organisationId` : il la tient de son chantier. Le
 * super-admin plateforme n'en ayant pas, lui passer la sienne (`null`) faisait
 * répondre « introuvable » sur tout l'onglet Documents d'un chantier client.
 * Voir utils/organisationRequete.js.
 */
const orgDuChantier = (req) => organisationCible(req, { chantierId: req.params.chantierId });
const orgDuDocument = (req) => organisationCible(req, { documentId: req.params.id });

exports.uploaderDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.upload(
    await orgDuChantier(req),
    req.params.chantierId,
    req.body,
    req.file,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { document: result.document } });
});

exports.listerDocuments = asyncHandler(async (req, res) => {
  const result = await DocumentService.listDocuments(await orgDuChantier(req), req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Documents récupérés',
    data: { documents: result.documents },
  });
});

exports.supprimerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.supprimerDocument(await orgDuDocument(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- ARCHIVAGE (module 7) --------------------
exports.archiverDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.archiverDocument(await orgDuDocument(req), req.params.id, true);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { document: result.document } });
});

exports.restaurerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.archiverDocument(await orgDuDocument(req), req.params.id, false);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { document: result.document } });
});

// -------------------- SIGNATURE (module 7) --------------------
exports.signerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.signerDocument(
    await orgDuDocument(req),
    req.params.id,
    req.body,
    req.user.id
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { signature: result.signature } });
});

exports.listerSignatures = asyncHandler(async (req, res) => {
  const result = await DocumentService.listSignatures(await orgDuDocument(req), req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Signatures récupérées', data: { signatures: result.signatures } });
});
