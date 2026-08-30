'use strict';

const express = require('express');
const router = express.Router();
const planController = require('../controller/planAbonnement.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3) : voir le commentaire
// du middleware pour le contexte (compte à plus haut risque de la plateforme).
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  creerPlanSchema, modifierPlanSchema, basculerActifPlanSchema,
} = require('../validation/planAbonnement.validation.js');

/**
 * Catalogue des formules — menu « Prix abonnements » de l'espace Admin.
 *
 * TOUT est réservé au SUPER-ADMIN plateforme (`requireRole('Admin')`). Le
 * catalogue est commun à toutes les organisations : un chef de projet ne doit
 * pas pouvoir modifier le tarif que paient les autres clients.
 *
 * Monté sous `/admin/…`, donc HORS de `checkSubscription` : l'administrateur
 * plateforme n'appartient à aucune organisation, il n'a pas d'abonnement à
 * vérifier — l'y soumettre lui fermerait l'administration qu'il exerce.
 *
 * Le catalogue PUBLIC, lui, est servi par `/abonnement/plans` : il ne renvoie
 * que les formules actives et jamais les champs de gestion.
 */

router.get('/', auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit, planController.lister);

router.get('/:id', auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit, planController.detail);

router.post(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(creerPlanSchema),
  planController.creer
);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(modifierPlanSchema),
  planController.modifier
);

// Geste courant du catalogue : retirer une formule de l'offre sans toucher
// aux abonnés en cours, qui la gardent jusqu'à leur échéance.
router.patch(
  '/:id/actif',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(basculerActifPlanSchema),
  planController.basculerActif
);

// Refusée dès qu'une souscription y renvoie — voir le service : supprimer
// effacerait le lien avec des transactions réelles.
router.delete('/:id', auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit, planController.supprimer);

module.exports = router;
