'use strict';

const express = require('express');
const router = express.Router();
const accountController = require('../controller/account.controller.js');
const chantierController = require('../../chantier/controller/chantier.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const { authRateLimit, mutationRateLimit, otpEmailRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  updateProfilSchema, changePasswordSchema, saveDeviceTokenSchema,
  activerMfaSchema, desactiverMfaSchema,
} = require('../validation/account.validation.js');
const { forgotPasswordSchema, resetPasswordSchema } = require('../../auth/validation/auth.validation.js');

// Photo de profil (facultative) — mémoire + validation magic bytes
const handleUpload = (req, res, next) => {
  upload.fields([{ name: 'photoProfil', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'Fichier trop volumineux. Taille maximale : 5 MB.' });
      }
      return res.status(400).json({ success: false, message: 'Erreur lors du traitement du fichier' });
    }
    upload.validateMagicBytes(req, res, next);
  });
};

// ── Compte ───────────────────────────────────────────────────────────────────
router.get('/me', auth, accountController.me);

// Projets (chantiers) auxquels l'utilisateur est affecté — module 1
// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get('/chantiers', auth, paginate(), chantierController.listerMesChantiers);

router.put(
  '/profil',
  auth,
  mutationRateLimit,
  handleUpload,
  validate(updateProfilSchema),
  accountController.modifierInfoPersonnelles
);

router.post('/device-token', auth, validate(saveDeviceTokenSchema), accountController.saveDeviceToken);

router.post(
  '/forgot-password',
  authRateLimit,
  otpEmailRateLimit,
  validate(forgotPasswordSchema),
  accountController.forgotPassword
);

router.post(
  '/reset-password',
  authRateLimit,
  otpEmailRateLimit,
  validate(resetPasswordSchema),
  accountController.resetPassword
);

router.put(
  '/change-password',
  auth,
  mutationRateLimit,
  validate(changePasswordSchema),
  accountController.changePassword
);

// ── RGPD ─────────────────────────────────────────────────────────────────────
// GET    /account/export-data     → export des données personnelles (art. 20)
// DELETE /account/delete-account  → suppression + pseudonymisation (art. 17)
router.get('/export-data', auth, accountController.exportData);

router.delete('/delete-account', auth, mutationRateLimit, accountController.deleteAccount);

// ── Module 1 : historique des connexions & sessions actives ──────────────────
router.get('/connexions', auth, paginate(), accountController.listConnexions);

router.get('/sessions', auth, paginate(), accountController.listSessions);

router.delete('/sessions', auth, mutationRateLimit, accountController.revokerToutesSessions);

router.delete('/sessions/:id', auth, accountController.revokerSession);

// ── Module 1 : authentification à deux facteurs (MFA) ────────────────────────
router.post('/mfa/provision', auth, accountController.provisionMfa);

router.post('/mfa/enable', auth, validate(activerMfaSchema), accountController.activerMfa);

router.post('/mfa/disable', auth, validate(desactiverMfaSchema), accountController.desactiverMfa);

module.exports = router;
