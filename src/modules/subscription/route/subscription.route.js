'use strict';

const express = require('express');
const router = express.Router();
const subscriptionController = require('../controller/subscription.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const { rawBodyMiddleware } = require('../../../middlewares/rawBody.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const { FACTURATION } = require('../../../config/roles.js');
const { creerPaymentIntentSchema } = require('../validation/subscription.validation.js');

// ── Page d'abonnement (accessible même sans abonnement) ─────────────────────────
// Plans publics
router.get('/plans', subscriptionController.getPlans);

// Statut de l'abonnement de l'org connectée
router.get('/status', auth, checkActiveUser, subscriptionController.getStatus);

// Détails du plan actuel + tous les plans (pour UI changement)
router.get('/plan-details', auth, checkActiveUser, subscriptionController.getPlanDetails);

// Droits et usage courants — consommés par le web et le mobile pour savoir
// quoi afficher. N'accorde rien : les gardes sont dans les middlewares.
router.get('/droits', auth, checkActiveUser, subscriptionController.getDroits);

// Historique des souscriptions, avec le prix RÉELLEMENT payé à chaque fois.
//
// `FACTURATION` et non `GESTION` : le compte 'Entreprise' créé à l'inscription
// est le TITULAIRE de l'abonnement. Lui refuser la lecture de ses propres
// paiements revenait à lui cacher ce qu'il a réglé — l'écran d'abonnement du
// mobile masquait d'ailleurs la section entière pour ce rôle.
router.get('/historique', auth, checkActiveUser, requireRole(...FACTURATION), subscriptionController.getHistorique);

// ── Création PaymentIntent (choix du plan) ──────────────────────────────────────
// Engager une dépense pour l'organisation relève de la gestion — et le
// titulaire de l'abonnement en fait partie.
//
// Sans 'Entreprise' dans ce groupe, le compte issu de l'inscription publique
// recevait un 403 sur le SEUL geste qui lève le mur de fin d'essai. Le bouton
// « Choisir » existait pourtant, sur le mobile comme sur le web : il menait à
// un refus.
router.post(
  '/payment-intent',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
  validate(creerPaymentIntentSchema),
  subscriptionController.creerPaymentIntent
);

// ── Changement de plan (abonnement existant) ────────────────────────────────────
// Même groupe que la souscription : qui peut souscrire peut changer de
// formule, sans quoi il faudrait résilier puis reprendre.
router.post(
  '/change-plan',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
  validate(creerPaymentIntentSchema),
  subscriptionController.changerPlan
);

// ── Annulation d'abonnement ─────────────────────────────────────────────────────
// Sans requireRole, n'importe quel membre — y compris un rôle Client externe —
// pouvait résilier l'abonnement et déclencher un 403 SUBSCRIPTION_REQUIRED sur
// toutes les routes métier, pour tous les membres, en une seule requête.
//
// `FACTURATION` : le titulaire doit pouvoir résilier ce qu'il a souscrit.
// Le laisser sur GESTION créait une organisation qui peut payer mais jamais
// arrêter — il aurait fallu écrire au support pour cela.
router.post(
  '/cancel',
  auth,
  checkActiveUser,
  requireRole(...FACTURATION),
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