'use strict';

const MediaService = require('../service/media.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');

exports.ajouterMedia = asyncHandler(async (req, res) => {
  const result = await MediaService.ajouterMedia(
    req.user.organisationId,
    req.params.id,
    req.body.type || 'photo',
    req.file,
    req.body,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { media: result.media } });
});

exports.listerMedias = asyncHandler(async (req, res) => {
  const result = await MediaService.listMedias(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Médias récupérés', data: { medias: result.medias } });
});

exports.supprimerMedia = asyncHandler(async (req, res) => {
  const result = await MediaService.supprimerMedia(req.user.organisationId, req.params.mediaId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- PHOTOS D'INSPECTION (module 6) --------------------
exports.ajouterPhotoInspection = asyncHandler(async (req, res) => {
  const result = await MediaService.ajouterPhotoInspection(
    req.user.organisationId,
    req.params.id,
    'photo',
    req.file,
    req.body,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { media: result.media } });
});

exports.listerPhotosInspection = asyncHandler(async (req, res) => {
  const result = await MediaService.listPhotosInspection(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Photos récupérées', data: { photos: result.medias } });
});
