'use strict';

const express = require('express');
const router = express.Router();
const chantierController = require('../controller/chantier.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const checkOrganisation = require('../../../middlewares/checkOrganisation.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, PILOTAGE, SENSIBLE } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { Chantier } = require('../../../models/index.js');
const {
  creerChantierSchema, modifierChantierSchema, changerStatutSchema,
  creerBatimentSchema, creerEtageSchema, creerZoneSchema, creerLotSchema,
  dupliquerChantierSchema, creerPhaseSchema, modifierPhaseSchema,
} = require('../validation/chantier.validation.js');

// ── Chantiers ────────────────────────────────────────────────────────────────
// paginate() : plafonne page/limit — `listChantiers` fait un findAndCountAll
// avec jointures ; `?limit=500000` chargeait tout le portefeuille de l'org.
router.get('/', auth, checkActiveUser, checkSubscription, paginate(), chantierController.listerChantiers);

router.post(
  '/',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerChantierSchema),
  chantierController.creerChantier
);

router.get('/:id', auth, checkActiveUser, checkSubscription, checkOrganisation(Chantier, 'organisationId'), chantierController.detailChantier);

router.put(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...OPERATIONNEL),
  validate(modifierChantierSchema),
  chantierController.modifierChantier
);

router.patch(
  '/:id/statut',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...PILOTAGE),
  validate(changerStatutSchema),
  chantierController.changerStatut
);

router.delete(
  '/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...SENSIBLE),
  chantierController.supprimerChantier
);

// ── Duplication (module 3) ───────────────────────────────────────────────────
router.post(
  '/:id/dupliquer',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...OPERATIONNEL),
  validate(dupliquerChantierSchema),
  chantierController.dupliquerChantier
);

// ── Phases & planning (module 3) ─────────────────────────────────────────────
router.get('/:id/phases', auth, checkActiveUser, checkSubscription, paginate(), chantierController.listerPhases);

router.post(
  '/:id/phases',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerPhaseSchema),
  chantierController.creerPhase
);

router.put(
  '/:id/phases/:phaseId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(modifierPhaseSchema),
  chantierController.modifierPhase
);

router.delete(
  '/:id/phases/:phaseId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  chantierController.supprimerPhase
);

// ── Calendrier / planning (module 3) ─────────────────────────────────────────
router.get('/:id/calendrier', auth, checkActiveUser, checkSubscription, chantierController.calendrier);

// ── Structure du chantier ────────────────────────────────────────────────────
router.post(
  '/:id/batiments',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerBatimentSchema),
  chantierController.creerBatiment
);

router.post(
  '/:id/batiments/:batimentId/etages',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerEtageSchema),
  chantierController.creerEtage
);

router.post(
  '/:id/batiments/:batimentId/etages/:etageId/zones',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerZoneSchema),
  chantierController.creerZone
);

router.post(
  '/:id/lots',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(creerLotSchema),
  chantierController.creerLot
);

router.get('/:id/lots', auth, checkActiveUser, checkSubscription, paginate(), chantierController.listerLots);

// ── Affectation des membres au chantier (module 1) ───────────────────────────
router.get('/:id/membres', auth, checkActiveUser, checkSubscription, paginate(), chantierController.listerMembresChantier);

router.post(
  '/:id/membres',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'MaitreOeuvre'),
  chantierController.assignerMembres
);

router.delete(
  '/:id/membres/:membreId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'MaitreOeuvre'),
  chantierController.retirerMembreChantier
);

module.exports = router;
