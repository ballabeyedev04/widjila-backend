'use strict';

const express = require('express');
const router = express.Router();
const paytechController = require('../controller/paytech.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { createPaymentSchema } = require('../validation/paytech.validation.js');

// Pour l'IPN, PayTech n'envoie pas de token JWT - on a besoin du body brut
// Mais on peut utiliser express.json() car PayTech envoie du JSON ou form-urlencoded
// Note: on n'utilise PAS rawBodyMiddleware ici car PayTech ne nécessite pas de vérification de signature basée sur le body brut

// ── Création d'un paiement (protégé) ────────────────────────────────────────────
router.post(
  '/payment',
  auth,
  checkActiveUser,
  validate(createPaymentSchema),
  paytechController.createPayment
);

// ── Vérification statut paiement (protégé) ──────────────────────────────────────
router.get(
  '/payment/status',
  auth,
  checkActiveUser,
  paytechController.getPaymentStatus
);

// ── Vérification après retour utilisateur (protégé) ─────────────────────────────
router.get(
  '/payment/verify',
  auth,
  checkActiveUser,
  paytechController.verifyPayment
);

// ── Webhook IPN PayTech (PUBLIC - sans auth) ────────────────────────────────────
// PayTech appelle cette URL pour notifier du résultat du paiement
router.post(
  '/ipn',
  paytechController.ipn
);

module.exports = router;