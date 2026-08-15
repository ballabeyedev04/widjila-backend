'use strict';

const express = require('express');
const router = express.Router();
const notificationController = require('../controller/notification.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { marquerLuesSchema, broadcastSchema } = require('../validation/notification.validation.js');

// ── Notifications ────────────────────────────────────────────────────────────
// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get('/', auth, checkActiveUser, checkSubscription, paginate(), notificationController.listerNotifications);

router.get('/non-lues/count', auth, checkActiveUser, checkSubscription, notificationController.compterNonLues);

router.patch(
  '/lues',
  auth,
  checkActiveUser,
  checkSubscription,
  validate(marquerLuesSchema),
  notificationController.marquerLues
);

// ── Broadcast (module 8) ─────────────────────────────────────────────────────
router.post(
  '/broadcast/organisation',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(broadcastSchema),
  notificationController.broadcastOrganisation
);

router.post(
  '/broadcast/chantiers/:chantierId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(broadcastSchema),
  notificationController.broadcastChantier
);

module.exports = router;
