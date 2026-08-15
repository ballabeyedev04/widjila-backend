'use strict';

const AccountService = require('../service/account.service.js');
const NotificationService = require('../../notification/service/notification.service.js');
const formatUser = require('../../../utils/formatUser.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.me = asyncHandler(async (req, res) => {
  const result = await AccountService.getMe(req.user.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Profil récupéré',
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.modifierInfoPersonnelles = asyncHandler(async (req, res) => {
  const result = await AccountService.modifierInfoPersonnelles(req.user.id, req.body, req.files || {});
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.saveDeviceToken = asyncHandler(async (req, res) => {
  const { token, platform } = req.body;
  if (!token) throw new BadRequestError('Token requis');
  await NotificationService.saveDeviceToken(req.user.id, token, platform || 'web');
  res.status(200).json({ success: true, message: 'Token enregistré' });
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  const result = await AccountService.forgotPassword(req.body.email);
  if (result.error) throw new NotFoundError(result.error);
  res.status(200).json({ success: true, message: result.message });
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, nouveau_mot_de_passe } = req.body;
  const result = await AccountService.resetPassword(email, otp, nouveau_mot_de_passe);
  if (result.error) throw new BadRequestError(result.error);
  res.status(200).json({ success: true, message: result.message });
});

exports.changePassword = asyncHandler(async (req, res) => {
  const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;
  const result = await AccountService.changePassword(req.user.id, ancien_mot_de_passe, nouveau_mot_de_passe);
  if (result.error) throw new BadRequestError(result.error);
  res.status(200).json({ success: true, message: result.message });
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  const result = await AccountService.deleteAccount(req.user.id);
  if (result.error) throw new BadRequestError(result.error);
  res.status(200).json({ success: true, message: result.message });
});

exports.exportData = asyncHandler(async (req, res) => {
  const result = await AccountService.exportData(req.user.id);
  if (result.error) throw new NotFoundError(result.error);
  res.status(200).json({ success: true, message: 'Données exportées avec succès', data: result });
});

// -------------------- MODULE 1 : CONNEXIONS / SESSIONS / MFA --------------------
exports.listConnexions = asyncHandler(async (req, res) => {
  const result = await AccountService.listConnexions(req.user.id, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Historique des connexions récupéré',
    data: { connexions: result.connexions, total: result.total },
  });
});

exports.listSessions = asyncHandler(async (req, res) => {
  const result = await AccountService.listSessions(req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Sessions récupérées', data: { sessions: result.sessions } });
});

exports.revokerSession = asyncHandler(async (req, res) => {
  const result = await AccountService.revokeSession(req.user.id, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.revokerToutesSessions = asyncHandler(async (req, res) => {
  const result = await AccountService.revokeAllSessions(req.user.id);
  res.status(200).json({ success: true, message: result.message });
});

exports.provisionMfa = asyncHandler(async (req, res) => {
  const result = await AccountService.provisionMfa(req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Secret MFA généré',
    data: { secret: result.secret, otpauthUrl: result.otpauthUrl, qr: result.qr },
  });
});

exports.activerMfa = asyncHandler(async (req, res) => {
  const result = await AccountService.activerMfa(req.user.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

exports.desactiverMfa = asyncHandler(async (req, res) => {
  const result = await AccountService.desactiverMfa(req.user.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
