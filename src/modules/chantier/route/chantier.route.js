'use strict';

const express = require('express');
const router = express.Router();
const chantierController = require('../controller/chantier.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const checkOrganisation = require('../../../middlewares/checkOrganisation.middleware.js');
const requireOrganisation = require('../../../middlewares/requireOrganisation.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, PILOTAGE, SENSIBLE, DEPOSANT, TITULAIRE, VALIDATION_CHANTIER } = require('../../../config/roles.js');
const { verifierLimite } = require('../../../middlewares/requireFonctionnalite.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { Chantier } = require('../../../models/index.js');
const {
  creerChantierSchema, modifierChantierSchema, changerStatutSchema,
  creerBatimentSchema, creerEtageSchema, creerZoneSchema, creerLotSchema,
  modifierBatimentSchema, modifierEtageSchema, modifierZoneSchema,
  dupliquerChantierSchema, creerPhaseSchema, modifierPhaseSchema,
  rejeterChantierSchema, assignerMembresSchema,
} = require('../validation/chantier.validation.js');

// ── Chantiers ────────────────────────────────────────────────────────────────
// paginate() : plafonne page/limit — `listChantiers` fait un findAndCountAll
// avec jointures ; `?limit=500000` chargeait tout le portefeuille de l'org.
router.get('/', auth, checkActiveUser, checkSubscription, paginate(), chantierController.listerChantiers);

// `requireOrganisation` : le chantier est rattaché à `req.user.organisationId`,
// que le super-admin plateforme (et tout compte créé sans organisation) n'a
// pas. Sans cette garde, l'appel descendait jusqu'à la contrainte NOT NULL de
// la base et renvoyait un 422 « notNull Violation » incompréhensible côté
// interface.
router.post(
  '/',
  auth,
  checkActiveUser,
  checkSubscription,
  requireOrganisation,
  // `DEPOSANT` et non `OPERATIONNEL` : le client demande que « n'importe qui
  // qui crée le chantier sauf Admin reste en attente ». L'entreprise, qui
  // dépose ses plans et demande l'ouverture du chantier, en était exclue —
  // elle recevait un 403 avant même d'atteindre le circuit de validation.
  //
  // Élargir la route n'élargit PAS ce qui est créé : tout dépôt hors
  // super-admin naît « en_attente_validation » et n'existe comme chantier
  // qu'une fois validé (voir chantier.service.js#creerChantier).
  requireRole(...DEPOSANT),
  // Plafond de chantiers de la formule. Aujourd'hui sans effet : le client
  // n'a fourni AUCUN nombre (la présentation cite « multi-chantiers » comme
  // avantage Pro, sans chiffrer Essentiel), donc `limite_chantiers` vaut NULL
  // — illimité — pour les trois formules. La garde est posée pour que fixer
  // ce plafond depuis l'administration suffise à l'appliquer, sans livraison.
  verifierLimite('chantiers'),
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

// ── Validation des demandes de chantier ──────────────────────────────────────
// `VALIDATION_CHANTIER` et non `GESTION` : le titulaire 'Entreprise' est dans
// GESTION depuis qu'il a tous les droits sur son organisation — mais valider
// SA PROPRE demande annulerait le circuit. Il dépose, un autre tranche.
// `checkOrganisation` interdit par ailleurs de trancher la demande d'un autre
// client.
router.patch(
  '/:id/valider',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...VALIDATION_CHANTIER),
  chantierController.validerChantier
);

router.patch(
  '/:id/rejeter',
  auth,
  checkActiveUser,
  checkSubscription,
  checkOrganisation(Chantier, 'organisationId'),
  requireRole(...VALIDATION_CHANTIER),
  validate(rejeterChantierSchema),
  chantierController.rejeterChantier
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
  // Une copie est un chantier de plus : même plafond de formule que la création.
  verifierLimite('chantiers'),
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

// ── Modification & suppression de la structure ───────────────────────────────
// Même groupe que la CRÉATION (OPERATIONNEL) : renommer un bâtiment ou retirer
// une zone vide relève de la même mise en place du chantier. La garde qui
// compte n'est pas le rôle mais l'état — le service REFUSE toute suppression
// tant qu'une réserve pointe sur l'élément (voir chantier.service.js).
router.put(
  '/:id/batiments/:batimentId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(modifierBatimentSchema),
  chantierController.modifierBatiment
);

router.delete(
  '/:id/batiments/:batimentId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  chantierController.supprimerBatiment
);

router.put(
  '/:id/batiments/:batimentId/etages/:etageId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(modifierEtageSchema),
  chantierController.modifierEtage
);

router.delete(
  '/:id/batiments/:batimentId/etages/:etageId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  chantierController.supprimerEtage
);

router.put(
  '/:id/batiments/:batimentId/etages/:etageId/zones/:zoneId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  validate(modifierZoneSchema),
  chantierController.modifierZone
);

router.delete(
  '/:id/batiments/:batimentId/etages/:etageId/zones/:zoneId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  chantierController.supprimerZone
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

// Qui peut encore être affecté — mêmes rôles que l'affectation elle-même.
// Sans cette route, le maître d'œuvre pouvait affecter mais pas voir qui :
// la liste des membres de l'organisation est réservée à GESTION_MEMBRES.
router.get(
  '/:id/membres/candidats',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'MaitreOeuvre', TITULAIRE),
  chantierController.listerCandidatsMembres
);

router.post(
  '/:id/membres',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'MaitreOeuvre', TITULAIRE),
  validate(assignerMembresSchema),
  chantierController.assignerMembres
);

router.delete(
  '/:id/membres/:membreId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'MaitreOeuvre', TITULAIRE),
  chantierController.retirerMembreChantier
);

module.exports = router;
