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
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { activerManuellementSchema } = require('../validation/planAbonnement.validation.js');

/**
 * Suivi des abonnements CLIENTS — espace Admin.
 *
 * Réservé au super-admin plateforme, et volontairement en LECTURE seule à une
 * exception près : l'activation manuelle. Aucune route ne permet de modifier
 * un statut, une échéance ou un montant déjà encaissé — ce serait réécrire une
 * transaction, et rendre l'historique inutilisable comme pièce comptable.
 */

// Liste filtrable par organisation et par statut. Le prix RÉELLEMENT payé y
// figure, figé à la souscription.
router.get(
  '/',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  paginate(),
  planController.listerSouscriptions
);

/**
 * Activation manuelle — le cas « Entreprise, sur devis ».
 *
 * C'est la seule écriture, et l'opération la plus sensible du module :
 * elle contourne délibérément le paiement en ligne. D'où trois garde-fous :
 * le rôle super-admin, la trace de l'auteur (`activee_par`) et l'obligation
 * d'un prix explicite enregistré dans l'historique.
 */
router.post(
  '/activer',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(activerManuellementSchema),
  planController.activerManuellement
);

module.exports = router;
