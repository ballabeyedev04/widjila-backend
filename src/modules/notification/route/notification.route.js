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
const {
  marquerLuesSchema, broadcastSchema, deviceTokenSchema, supprimerDeviceTokenSchema,
} = require('../validation/notification.validation.js');

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

// ── Appareils (push FCM) ────────────────────────────────────────────────
// Aucun `requireRole` : tout utilisateur authentifié peut déclarer SON
// appareil. Le jeton est rattaché à `req.user.id`, jamais à un identifiant
// fourni par le client. Pas de `checkSubscription` non plus : couper
// l'enregistrement d'un appareil pour un abonnement expiré empêcherait
// justement de prévenir l'utilisateur.
router.post(
  '/device-token',
  auth,
  checkActiveUser,
  validate(deviceTokenSchema),
  notificationController.enregistrerDeviceToken
);

router.delete(
  '/device-token',
  auth,
  checkActiveUser,
  validate(supprimerDeviceTokenSchema),
  notificationController.supprimerDeviceToken
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
