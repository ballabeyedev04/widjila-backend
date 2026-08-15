'use strict';

const express = require('express');
const router = express.Router();
const authController = require('../controller/auth.controller.js');
const { authRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  registerSchema, loginSchema, refreshSchema, logoutSchema,
  mfaVerifySchema, verifyEmailSchema,
} = require('../validation/auth.validation.js');

// ── Authentification ─────────────────────────────────────────────────────────
router.post('/register', authRateLimit, validate(registerSchema), authController.inscriptionUser);
router.post('/login',    authRateLimit, validate(loginSchema),    authController.login);
router.post('/refresh',  authRateLimit, validate(refreshSchema),  authController.refresh);
router.post('/logout',   authRateLimit, validate(logoutSchema),   authController.logout);

// ── Vérification de l'email à l'inscription (audit M5) ──────────────────────
router.post('/verify-email', authRateLimit, validate(verifyEmailSchema), authController.verifierEmail);

// ── MFA (module 1) : validation du code TOTP après un login à 2 facteurs ────
router.post('/mfa-verify', authRateLimit, validate(mfaVerifySchema), authController.verifierMfa);

module.exports = router;
