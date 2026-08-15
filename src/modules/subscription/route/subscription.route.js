'use strict';

const express = require('express');
const router = express.Router();
const subscriptionController = require('../controller/subscription.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const { rawBodyMiddleware } = require('../../../middlewares/rawBody.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const { creerPaymentIntentSchema } = require('../validation/subscription.validation.js');

// ── Page d'abonnement (accessible même sans abonnement) ─────────────────────────
// Plans publics
router.get('/plans', subscriptionController.getPlans);

// Statut de l'abonnement de l'org connectée
router.get('/status', auth, checkActiveUser, subscriptionController.getStatus);

// Détails du plan actuel + tous les plans (pour UI changement)
router.get('/plan-details', auth, checkActiveUser, subscriptionController.getPlanDetails);

// ── Création PaymentIntent (choix du plan) ──────────────────────────────────────
// Engager une dépense pour l'organisation relève de la gestion.
router.post(
  '/payment-intent',
  auth,
  checkActiveUser,
  requireRole(...GESTION),
  validate(creerPaymentIntentSchema),
  subscriptionController.creerPaymentIntent
);

// ── Changement de plan (abonnement existant) ────────────────────────────────────
router.post(
  '/change-plan',
  auth,
  checkActiveUser,
  requireRole(...GESTION),
  validate(creerPaymentIntentSchema),
  subscriptionController.changerPlan
);

// ── Annulation d'abonnement ─────────────────────────────────────────────────────
// Sans requireRole, n'importe quel membre — y compris un rôle Client externe —
// pouvait résilier l'abonnement et déclencher un 403 SUBSCRIPTION_REQUIRED sur
// toutes les routes métier, pour tous les membres, en une seule requête.
router.post(
  '/cancel',
  auth,
  checkActiveUser,
  requireRole(...GESTION),
  subscriptionController.annulerAbonnement
);

// ── Webhook Stripe (sans auth, accessible depuis Stripe) ────────────────────────
// IMPORTANT : la vérification de signature Stripe porte sur les OCTETS BRUTS.
//
// `rawBodyMiddleware` doit rester le TOUT PREMIER middleware de cette route :
// dès qu'un parseur a lu le flux, les octets d'origine sont perdus
// définitivement et la signature ne peut plus être recalculée.
//
// À lui seul il ne suffit toutefois pas : `app.js` monte `express.json()`
// globalement AVANT les routes, donc le flux est déjà consommé ici. La capture
// réelle est faite en amont par le hook `verify` que
// `middlewares/rawBody.middleware.js` installe sur `express.json` au moment de
// son chargement (voir l'explication détaillée dans ce fichier).
// Ne pas insérer `validate()`, `auth` ni aucun autre parseur avant cette ligne.
router.post(
  '/webhook',
  rawBodyMiddleware,
  subscriptionController.webhook
);

module.exports = router;