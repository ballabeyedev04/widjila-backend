'use strict';

const NotificationService = require('../service/notification.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.listerNotifications = asyncHandler(async (req, res) => {
  const result = await NotificationService.listNotifications(req.user.id, req.query);
  res.status(200).json({
    success: true,
    message: 'Notifications récupérées',
    data: {
      notifications: result.notifications,
      total: result.total,
      nonLuesCount: result.nonLuesCount,
    },
  });
});

exports.marquerLues = asyncHandler(async (req, res) => {
  const result = await NotificationService.marquerLues(req.user.id, req.body?.ids || []);
  res.status(200).json({ success: true, message: result.message });
});

exports.compterNonLues = asyncHandler(async (req, res) => {
  const result = await NotificationService.listNotifications(req.user.id, { nonLues: true, limit: 1 });
  res.status(200).json({
    success: true,
    message: 'Compteur récupéré',
    data: { nonLuesCount: result.nonLuesCount },
  });
});

// -------------------- BROADCAST (module 8) --------------------
exports.broadcastOrganisation = asyncHandler(async (req, res) => {
  const result = await NotificationService.broadcastOrganisation(req.user.organisationId, {
    type: req.body.type || 'broadcast',
    titre: req.body.titre,
    message: req.body.message || null,
    donnees: req.body.donnees || null,
  });
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: `Notification envoyée à ${result.total} membre(s)`, data: result });
});

exports.broadcastChantier = asyncHandler(async (req, res) => {
  const result = await NotificationService.broadcastChantier(req.user.organisationId, req.params.chantierId, {
    type: req.body.type || 'broadcast',
    titre: req.body.titre,
    message: req.body.message || null,
    donnees: req.body.donnees || null,
  });
  if (!result.success) throw new NotFoundError(result.message);
  res.status(201).json({ success: true, message: `Notification envoyée à ${result.total} membre(s)`, data: result });
});
