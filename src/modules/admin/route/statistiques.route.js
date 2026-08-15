'use strict';

const express = require('express');
const router = express.Router();
const adminController = require('../controller/statistiques.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3) : voir le commentaire
// du middleware pour le contexte (compte à plus haut risque de la plateforme).
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');

// ── Statistiques plateforme (super-admin) ────────────────────────────────────
router.get('/', auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit, adminController.statsPlateforme);

router.get(
  '/croissance',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  adminController.croissanceInscriptions
);

module.exports = router;
