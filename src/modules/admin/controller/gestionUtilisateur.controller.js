'use strict';

const GestionUtilisateurService = require('../service/gestionUtilisateur.service.js');
const formatUser = require('../../../utils/formatUser.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.listerUtilisateurs = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.listUtilisateurs(req.query);
  res.status(200).json({
    success: true,
    message: 'Utilisateurs récupérés',
    data: { utilisateurs: result.utilisateurs, total: result.total },
  });
});

exports.detailUtilisateur = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.getUtilisateur(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Utilisateur récupéré', data: { utilisateur: result.utilisateur } });
});

exports.creerUtilisateur = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.creerUtilisateur(req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.modifierUtilisateur = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.modifierUtilisateur(req.params.id, req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.changerRole = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.changerRole(req.params.id, req.body.role, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.modifierPermissions = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.modifierPermissions(
    req.params.id,
    req.body.permissions,
    req.user,
    req.ip
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.supprimerUtilisateur = asyncHandler(async (req, res) => {
  const result = await GestionUtilisateurService.supprimerUtilisateur(req.params.id, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
