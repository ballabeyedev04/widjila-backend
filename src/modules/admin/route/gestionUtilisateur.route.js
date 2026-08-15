'use strict';

const express = require('express');
const router = express.Router();
const adminController = require('../controller/gestionUtilisateur.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3).
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  creerUtilisateurAdminSchema, modifierUtilisateurAdminSchema,
  changerRoleSchema, modifierPermissionsSchema,
} = require('../validation/admin.validation.js');

// ── Gestion des utilisateurs (super-admin) ───────────────────────────────────
// paginate() : plafonne page/limit — sans lui, `?limit=500000` dumpait la table
// utilisateur de TOUTE la plateforme en une requête (voir pagination.middleware.js).
router.get(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  paginate(),
  adminController.listerUtilisateurs
);

router.get(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  adminController.detailUtilisateur
);

router.post(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(creerUtilisateurAdminSchema),
  adminController.creerUtilisateur
);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(modifierUtilisateurAdminSchema),
  adminController.modifierUtilisateur
);

router.patch(
  '/:id/role',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(changerRoleSchema),
  adminController.changerRole
);

router.put(
  '/:id/permissions',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(modifierPermissionsSchema),
  adminController.modifierPermissions
);

router.delete(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  adminController.supprimerUtilisateur
);

module.exports = router;
