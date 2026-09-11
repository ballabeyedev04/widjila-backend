'use strict';

const express = require('express');
const router = express.Router();
const paytechController = require('../controller/paytech.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const { FACTURATION } = require('../../../config/roles.js');
const { createPaymentSchema } = require('../validation/paytech.validation.js');

// FACTURATION sur les trois routes authentifiées : comme pour Stripe
// (subscription.route.js), seul qui règle l'abonnement de l'organisation peut
// en lancer ou en consulter un paiement. Sans cette garde, un compte Client
// remplaçait la formule de l'organisation, et `status`/`verify` relayaient
// vers PayTech le statut de n'importe quel jeton de paiement.

// Pour l'IPN, PayTech n'envoie pas de token JWT - on a besoin du body brut
// Mais on peut utiliser express.json() car PayTech envoie du JSON ou form-urlencoded
// Note: on n'utilise PAS rawBodyMiddleware ici car PayTech ne nécessite pas de vérification de signature basée sur le body brut

// ── Création d'un paiement (protégé) ────────────────────────────────────────────
router.post(
  '/payment',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
  validate(createPaymentSchema),
  paytechController.createPayment
);

// ── Vérification statut paiement (protégé) ──────────────────────────────────────
router.get(
  '/payment/status',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
  paytechController.getPaymentStatus
);

// ── Vérification après retour utilisateur (protégé) ─────────────────────────────
router.get(
  '/payment/verify',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
  paytechController.verifyPayment
);

// ── Webhook IPN PayTech (PUBLIC - sans auth) ────────────────────────────────────
// PayTech appelle cette URL pour notifier du résultat du paiement
router.post(
  '/ipn',
  paytechController.ipn
);

module.exports = router;