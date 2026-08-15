'use strict';

const DocumentService = require('../service/document.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.uploaderDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.upload(
    req.user.organisationId,
    req.params.chantierId,
    req.body,
    req.file,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { document: result.document } });
});

exports.listerDocuments = asyncHandler(async (req, res) => {
  const result = await DocumentService.listDocuments(req.user.organisationId, req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Documents récupérés',
    data: { documents: result.documents },
  });
});

exports.supprimerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.supprimerDocument(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- ARCHIVAGE (module 7) --------------------
exports.archiverDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.archiverDocument(req.user.organisationId, req.params.id, true);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { document: result.document } });
});

exports.restaurerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.archiverDocument(req.user.organisationId, req.params.id, false);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { document: result.document } });
});

// -------------------- SIGNATURE (module 7) --------------------
exports.signerDocument = asyncHandler(async (req, res) => {
  const result = await DocumentService.signerDocument(
    req.user.organisationId,
    req.params.id,
    req.body,
    req.user.id
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { signature: result.signature } });
});

exports.listerSignatures = asyncHandler(async (req, res) => {
  const result = await DocumentService.listSignatures(req.user.organisationId, req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Signatures récupérées', data: { signatures: result.signatures } });
});
