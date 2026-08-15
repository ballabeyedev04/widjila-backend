'use strict';

const express = require('express');
const router = express.Router();
const adminController = require('../controller/gestionOrganisation.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3).
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  creerOrganisationSchema, modifierOrganisationSchema,
} = require('../../organisation/validation/organisation.validation.js');

// ── Gestion des organisations (super-admin) ──────────────────────────────────
// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  paginate(),
  adminController.listerOrganisations
);

router.get(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  adminController.detailOrganisation
);

router.post(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(creerOrganisationSchema),
  adminController.creerOrganisation
);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(modifierOrganisationSchema),
  adminController.modifierOrganisation
);

router.delete(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  adminController.supprimerOrganisation
);

module.exports = router;
