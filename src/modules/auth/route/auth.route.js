'use strict';

const express = require('express');
const router = express.Router();
const authController = require('../controller/auth.controller.js');
const { authRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  registerSchema, loginSchema, refreshSchema, logoutSchema, mfaVerifySchema,
} = require('../validation/auth.validation.js');

// ── Authentification ─────────────────────────────────────────────────────────
router.post('/register', authRateLimit, validate(registerSchema), authController.inscriptionUser);
router.post('/login',    authRateLimit, validate(loginSchema),    authController.login);
router.post('/refresh',  authRateLimit, validate(refreshSchema),  authController.refresh);
router.post('/logout',   authRateLimit, validate(logoutSchema),   authController.logout);

// ── MFA (module 1) : validation du code TOTP après un login à 2 facteurs ────
router.post('/mfa-verify', authRateLimit, validate(mfaVerifySchema), authController.verifierMfa);

module.exports = router;
