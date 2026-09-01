'use strict';

const express = require('express');
const router = express.Router();
const authController = require('../controller/auth.controller.js');
const { authRateLimit, sessionRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  registerSchema, loginSchema, refreshSchema, logoutSchema, mfaVerifySchema,
} = require('../validation/auth.validation.js');

// ── Authentification ─────────────────────────────────────────────────────────
router.post('/register', authRateLimit, validate(registerSchema), authController.inscriptionUser);
router.post('/login',    authRateLimit, validate(loginSchema),    authController.login);
// `sessionRateLimit` et non `authRateLimit` : rafraîchir ou fermer une session
// n'est pas une tentative d'authentification. Les deux exigent un refresh token
// déjà valide, et les compter avec les connexions bloquait l'utilisateur
// légitime dont le client rafraîchit son jeton tout seul.
router.post('/refresh',  sessionRateLimit, validate(refreshSchema),  authController.refresh);
router.post('/logout',   sessionRateLimit, validate(logoutSchema),   authController.logout);

// ── MFA (module 1) : validation du code TOTP après un login à 2 facteurs ────
router.post('/mfa-verify', authRateLimit, validate(mfaVerifySchema), authController.verifierMfa);

module.exports = router;
