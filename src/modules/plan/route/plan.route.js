'use strict';

const express = require('express');
const router = express.Router();
const planController = require('../controller/plan.controller.js');
const annotationController = require('../controller/annotation.controller.js');
const hotspotController = require('../controller/hotspot.controller.js');
const { requireFonctionnalite } = require('../../../middlewares/requireFonctionnalite.middleware.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, OPERATIONNEL_CONTROLE, DEPOSANT } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  uploadPlanSchema, creerAnnotationSchema, modifierAnnotationSchema,
  creerHotspotSchema, modifierHotspotSchema, deposerVersionSchema,
} = require('../validation/plan.validation.js');

// Le chantierId est porté par l'URL → injecté dans le body avant validation Joi
const injectChantierId = (req, res, next) => {
  req.body.chantierId = req.params.chantierId;
  next();
};

// ── Plans ────────────────────────────────────────────────────────────────────
router.post(
  '/chantiers/:chantierId/plans',
  auth,
  checkActiveUser,
  checkSubscription,
  // `DEPOSANT` et non `OPERATIONNEL_CONTROLE` : le parcours « Envoi Plan »
  // veut que l'entreprise joigne ses plans à sa demande de chantier.
  //
  // Ce n'est qu'un premier filtre GROSSIER. La garde qui compte est dans
  // `plan.service.js#upload` : un rôle hors OPERATIONNEL_CONTROLE ne dépose
  // que sur SA PROPRE demande encore en attente. Sur un chantier en activité,
  // les autorisations sont inchangées.
  requireRole(...DEPOSANT),
  upload.single('fichier'),
  upload.validateMagicBytes,
  injectChantierId,
  validate(uploadPlanSchema),
  planController.uploaderPlan
);

// Plans GLOBAUX du chantier — le point d'entrée de la navigation par niveau.
//
// Déclarée AVANT `/chantiers/:chantierId/plans` : les deux motifs ne se
// recouvrent pas (Express compare le chemin complet), mais l'ordre suit celui
// du parcours — on entre par les plans globaux, puis on descend par
// `/plans/:id/sous-plans`.
//
// Lecture seule, mêmes droits que la liste complète : consulter la racine de
// l'arborescence ne demande pas plus que consulter les plans du chantier.
router.get(
  '/chantiers/:chantierId/plans/racines',
  auth,
  checkActiveUser,
  checkSubscription,
  planController.listerPlansRacines
);

// paginate() : plafonne page/limit avant que la query n'atteigne le service
// (voir pagination.middleware.js — `?limit=500000` chargeait tout le chantier).
router.get('/chantiers/:chantierId/plans', auth, checkActiveUser, checkSubscription, paginate(), planController.listerPlans);

// Liste TRANSVERSALE (tous chantiers) — onglet « Plans » de premier niveau.
router.get('/plans', auth, checkActiveUser, checkSubscription, planController.listerTousPlans);

router.get('/plans/:id', auth, checkActiveUser, checkSubscription, planController.detailPlan);

// Sous-plans DIRECTS d'un plan — la descente d'un cran dans l'arborescence.
//
// Déclarée après `/plans/:id` sans ambiguïté : les deux motifs ne se
// recouvrent pas. Lecture seule, ouverte aux mêmes comptes que le détail :
// consulter un plan de détail ne demande pas plus de droits que consulter le
// plan dont il dépend.
router.get('/plans/:id/sous-plans', auth, checkActiveUser, checkSubscription, planController.listerSousPlans);

// Réserves posées sur un plan — cahier technique § 11.
//
// Le détail du plan les porte déjà ; cette route sert à les RAFRAÎCHIR seules,
// après une création, sans re-télécharger la fiche du plan. Mêmes droits que le
// détail : consulter les repères d'un plan ne demande pas plus que consulter le
// plan.
router.get('/plans/:id/reserves', auth, checkActiveUser, checkSubscription, planController.listerReservesDuPlan);

// ── Comparaison des versions d'un plan (module 4) ────────────────────────────
router.get('/plans/:id/versions', auth, checkActiveUser, checkSubscription, paginate(), annotationController.listerVersionsPlan);

// Déposer une NOUVELLE VERSION d'un plan — cahier technique § 11 et § 15.
//
// Mêmes rôles et mêmes contrôles que le dépôt initial : c'est le même geste,
// désigné autrement. `upload.single` puis `validateMagicBytes` : un PDF
// renommé en .png est rejeté ici comme ailleurs.
router.post(
  '/plans/:id/versions',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...DEPOSANT),
  upload.single('fichier'),
  upload.validateMagicBytes,
  validate(deposerVersionSchema),
  planController.deposerVersion
);

// ── Annotations sur un plan (module 4) ───────────────────────────────────────
router.get('/plans/:id/annotations', auth, checkActiveUser, checkSubscription, paginate(), annotationController.listerAnnotations);

// CAUSE DU CORRECTIF : la création et la modification d'annotations n'avaient
// AUCUN `requireRole`, alors que le DELETE juste en dessous exige OPERATIONNEL.
// N'importe quel utilisateur authentifié de l'organisation — y compris le rôle
// `Client`, que le cahier des charges cantonne à « lecture, signatures,
// commentaires », et `Entreprise` — pouvait poser et réécrire des marqueurs,
// cotes et repères sur les plans d'exécution.
//
// Choix de OPERATIONNEL_CONTROLE (et non OPERATIONNEL) : c'est le groupe déjà
// utilisé pour l'UPLOAD d'un plan dans ce même module. Le bureau de contrôle
// doit pouvoir annoter les plans dans le cadre de ses contrôles — l'exclure de
// l'annotation tout en l'autorisant à déposer des plans serait incohérent.
// La SUPPRESSION reste volontairement plus restrictive (OPERATIONNEL), alignée
// sur DELETE /plans/:id : détruire une annotation est irréversible.
router.post(
  '/plans/:id/annotations',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  // « Plans & annotations » — option avancée (Pro, Entreprise).
  //
  // Seule l'ANNOTATION est gardée, jamais la consultation ni le dépôt d'un
  // plan : créer une réserve en cliquant sur un plan relève de « Gestion des
  // réserves », incluse dans TOUTES les formules. Fermer les plans à
  // Essentiel viderait sa fonctionnalité principale.
  requireFonctionnalite('annotations'),
  validate(creerAnnotationSchema),
  annotationController.creerAnnotation
);

router.put(
  '/annotations/:annotationId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  requireFonctionnalite('annotations'),
  validate(modifierAnnotationSchema),
  annotationController.modifierAnnotation
);

router.delete(
  '/annotations/:annotationId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  annotationController.supprimerAnnotation
);

// ── Zones cliquables d'un plan (navigation du guide client) ─────────────────
// La LECTURE est ouverte à tout membre authentifié : sans elle, aucun rôle ne
// peut descendre du plan global vers un appartement — c'est le parcours de
// consultation lui-même, pas une opération d'édition.
router.get('/plans/:id/hotspots', auth, checkActiveUser, checkSubscription, hotspotController.listerHotspots);

// L'ÉCRITURE suit exactement le groupe qui dépose les plans et les annote
// (OPERATIONNEL_CONTROLE) : dessiner la zone cliquable d'un bâtiment fait
// partie de la mise en place du plan, pas de son exploitation.
router.post(
  '/plans/:id/hotspots',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  requireFonctionnalite('annotations'),
  validate(creerHotspotSchema),
  hotspotController.creerHotspot
);

router.put(
  '/hotspots/:hotspotId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(modifierHotspotSchema),
  hotspotController.modifierHotspot
);

// Alignée sur DELETE /annotations/:annotationId : la suppression reste plus
// restrictive que la création.
router.delete(
  '/hotspots/:hotspotId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  hotspotController.supprimerHotspot
);

router.delete(
  '/plans/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  planController.supprimerPlan
);

module.exports = router;
