'use strict';

const express = require('express');
const router = express.Router();
const documentController = require('../controller/document.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, OPERATIONNEL_CONTROLE } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { uploadDocumentSchema, signerDocumentSchema } = require('../validation/document.validation.js');

// Le chantierId est porté par l'URL → injecté dans le body avant validation Joi
const injectChantierId = (req, res, next) => {
  req.body.chantierId = req.params.chantierId;
  next();
};

// ── Documents (GED du chantier) ──────────────────────────────────────────────
router.post(
  '/chantiers/:chantierId/documents',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  upload.single('fichier'),
  upload.validateMagicBytes,
  injectChantierId,
  validate(uploadDocumentSchema),
  documentController.uploaderDocument
);

// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get('/chantiers/:chantierId/documents', auth, checkActiveUser, checkSubscription, paginate(), documentController.listerDocuments);

// ── Archivage (module 7) ──────────────────────────────────────────────────────
router.post(
  '/documents/:id/archive',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  documentController.archiverDocument
);

router.post(
  '/documents/:id/restaurer',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  documentController.restaurerDocument
);

// ── Signature (module 7) ──────────────────────────────────────────────────────
router.post(
  '/documents/:id/signature',
  auth,
  checkActiveUser,
  checkSubscription,
  validate(signerDocumentSchema),
  documentController.signerDocument
);

router.get('/documents/:id/signatures', auth, checkActiveUser, checkSubscription, paginate(), documentController.listerSignatures);

router.delete(
  '/documents/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  documentController.supprimerDocument
);

module.exports = router;
