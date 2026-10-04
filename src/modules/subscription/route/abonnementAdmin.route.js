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
const devisController = require('../controller/devis.controller.js');
const { preparerDevisSchema, listerDevisSchema } = require('../validation/devis.validation.js');

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

/**
 * DEVIS — le chiffrage, réservé au super-admin.
 *
 * C'est ici que naissent les montants : le client, lui, ne fait que décrire
 * son besoin (voir `subscription.route.js`). Mêmes garde-fous que
 * l'activation manuelle — rôle, MFA, limitation de débit — puisqu'il s'agit
 * d'écrire ce qui sera débité.
 */
router.get(
  '/devis',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  paginate(),
  validate(listerDevisSchema, 'query'),
  devisController.listerTout
);

router.put(
  '/devis/:id',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  validate(preparerDevisSchema),
  devisController.preparer
);

// L'envoi est séparé du chiffrage : on prépare, on relit, puis on transmet.
// Un devis part sous les yeux du client, il ne se rattrape pas.
router.post(
  '/devis/:id/envoyer',
  auth,
  checkActiveUser,
  requireRole('Admin'),
  requireMfaActive,
  adminRateLimit,
  devisController.envoyer
);

module.exports = router;
