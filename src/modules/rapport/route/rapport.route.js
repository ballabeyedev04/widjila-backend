'use strict';

const express = require('express');
const router = express.Router();
const rapportController = require('../controller/rapport.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, PILOTAGE } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { genererRapportSchema } = require('../validation/rapport.validation.js');

// Le chantierId est porté par l'URL → injecté dans le body avant validation Joi
const injectChantierId = (req, res, next) => {
  req.body.chantierId = req.params.chantierId;
  next();
};

// ── Rapports PDF ─────────────────────────────────────────────────────────────
router.post(
  '/chantiers/:chantierId/rapports/generer',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...PILOTAGE),
  injectChantierId,
  validate(genererRapportSchema),
  rapportController.genererRapport
);

// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get('/chantiers/:chantierId/rapports', auth, checkActiveUser, checkSubscription, paginate(), rapportController.listerRapports);

router.get('/rapports/:id', auth, checkActiveUser, checkSubscription, rapportController.detailRapport);

router.delete(
  '/rapports/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  rapportController.supprimerRapport
);

module.exports = router;
