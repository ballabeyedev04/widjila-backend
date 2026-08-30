'use strict';

const express = require('express');
const router = express.Router();
const corpsEtatController = require('../controller/corpsEtat.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const {
  creerCorpsEtatSchema, modifierCorpsEtatSchema, basculerActifSchema,
} = require('../validation/corpsEtat.validation.js');

/**
 * Corps d'état — catalogue des métiers / types de travaux du BTP.
 *
 * LECTURE ouverte à tout membre authentifié : choisir le métier d'une réserve
 * fait partie du travail courant de chacun, pas de l'administration. C'est
 * d'ailleurs la raison d'être de `/actifs`, que consomment les listes
 * déroulantes du web et du mobile.
 *
 * ÉCRITURE sur GESTION — le même groupe que l'organisation et les équipes :
 * le catalogue est une donnée de référence de l'entreprise, au même titre que
 * son organigramme. La garde FINE (ne pas toucher au catalogue standard, ne
 * pas toucher à celui d'une autre organisation) vit dans le service.
 */

// ── Lecture ──────────────────────────────────────────────────────────────────
// Déclarée AVANT `/:id` : sans cela, « actifs » serait interprété comme un
// identifiant et la route ne répondrait jamais.
router.get('/actifs', auth, checkActiveUser, checkSubscription, corpsEtatController.listerActifs);

router.get('/', auth, checkActiveUser, checkSubscription, paginate(), corpsEtatController.lister);

router.get('/:id', auth, checkActiveUser, checkSubscription, corpsEtatController.detail);

// Répartition par phase — en-tête de l'écran « historique par entreprise ».
// La liste des réserves elle-même vient de GET /reserves?corpsEtatId=…&phaseId=…
router.get('/:id/historique', auth, checkActiveUser, checkSubscription, corpsEtatController.historique);

// ── Écriture ─────────────────────────────────────────────────────────────────
router.post(
  '/',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(creerCorpsEtatSchema),
  corpsEtatController.creer
);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(modifierCorpsEtatSchema),
  corpsEtatController.modifier
);

// Route dédiée à la bascule actif/inactif : c'est le geste courant du
// catalogue, et il mérite d'être distinct d'une modification complète — ne
// serait-ce que pour rester lisible dans le journal d'audit.
router.patch(
  '/:id/actif',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(basculerActifSchema),
  corpsEtatController.basculerActif
);

router.delete(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  corpsEtatController.supprimer
);

module.exports = router;
