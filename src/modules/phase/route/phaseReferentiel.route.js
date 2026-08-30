'use strict';

const express = require('express');
const router = express.Router();
const phaseController = require('../controller/phaseReferentiel.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const {
  creerPhaseReferentielSchema, modifierPhaseReferentielSchema, basculerActifPhaseSchema,
} = require('../validation/phaseReferentiel.validation.js');

/**
 * Référentiel des phases de chantier — Pré-cloisons, Cloisons, OPR…
 *
 * Monté sur `/api/v1/phases`, à ne pas confondre avec
 * `/api/v1/chantiers/:id/phases`, qui sert le PLANNING d'un chantier donné.
 * Les deux vivent dans la même table mais ne partagent aucune opération.
 *
 * LECTURE ouverte à tout membre authentifié : choisir la phase d'une réserve
 * fait partie du travail de terrain. C'est la raison d'être de `/actives`.
 *
 * ÉCRITURE sur GESTION — le même groupe que l'organisation, les équipes et le
 * catalogue des corps d'état : le référentiel est une donnée de référence de
 * l'entreprise. Un utilisateur hors de ce groupe est refusé côté serveur, pas
 * seulement masqué dans l'interface.
 */

// Déclarée AVANT `/:id` : sans cela, « actives » serait pris pour un
// identifiant et la route ne répondrait jamais.
router.get('/actives', auth, checkActiveUser, checkSubscription, phaseController.listerActives);

router.get('/', auth, checkActiveUser, checkSubscription, paginate(), phaseController.lister);

router.get('/:id', auth, checkActiveUser, checkSubscription, phaseController.detail);

router.post(
  '/',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(creerPhaseReferentielSchema),
  phaseController.creer
);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(modifierPhaseReferentielSchema),
  phaseController.modifier
);

// Route dédiée à la bascule : c'est le geste NORMAL de retrait d'une phase
// (la suppression étant refusée dès qu'une réserve s'y rattache), et il reste
// ainsi lisible dans le journal d'audit.
router.patch(
  '/:id/actif',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(basculerActifPhaseSchema),
  phaseController.basculerActif
);

router.delete(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  phaseController.supprimer
);

module.exports = router;
