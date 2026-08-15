'use strict';

const express = require('express');
const router = express.Router();
const adminController = require('../controller/auditLog.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3).
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');

// ── Journal d'audit (super-admin) ────────────────────────────────────────────
// paginate() : plafonne page/limit — le journal d'audit est la table la plus
// volumineuse de la plateforme (voir pagination.middleware.js).
router.get('/', auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit, paginate(), adminController.listerLogs);

module.exports = router;
