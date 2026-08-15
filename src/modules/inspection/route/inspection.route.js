'use strict';

const express = require('express');
const router = express.Router();
const inspectionController = require('../controller/inspection.controller.js');
const inspectionExtraController = require('../controller/inspectionExtra.controller.js');
const mediaController = require('../../media/controller/media.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, OPERATIONNEL_CONTROLE } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  creerInspectionSchema, modifierInspectionSchema, cocherChecklistSchema,
  creerModeleSchema, modifierModeleSchema, convierSchema, repondreConvocationSchema, appliquerModeleSchema,
} = require('../validation/inspection.validation.js');

// Le chantierId est porté par l'URL → injecté dans le body avant validation Joi
const injectChantierId = (req, res, next) => {
  req.body.chantierId = req.params.chantierId;
  next();
};

// ── Modèles de checklist (module 6) ──────────────────────────────────────────
// IMPORTANT : ces routes sont déclarées AVANT '/inspections/:id'. Express
// résout dans l'ordre de déclaration — placée après, '/inspections/modeles'
// serait captée par la route paramétrée, qui chercherait une inspection dont
// l'identifiant vaut « modeles » et ferait échouer la requête sur le type UUID.
router.get('/inspections/modeles', auth, checkActiveUser, checkSubscription, paginate(), inspectionExtraController.listerModeles);

router.post(
  '/inspections/modeles',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(creerModeleSchema),
  inspectionExtraController.creerModele
);

router.put(
  '/inspections/modeles/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(modifierModeleSchema),
  inspectionExtraController.modifierModele
);

router.delete(
  '/inspections/modeles/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  inspectionExtraController.supprimerModele
);

// ── Inspections / OPR / visites contradictoires ──────────────────────────────
router.get('/chantiers/:chantierId/inspections', auth, checkActiveUser, checkSubscription, paginate(), inspectionController.listerInspections);

router.post(
  '/chantiers/:chantierId/inspections',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  injectChantierId,
  validate(creerInspectionSchema),
  inspectionController.creerInspection
);

router.get('/inspections/:id', auth, checkActiveUser, checkSubscription, inspectionController.detailInspection);

router.put(
  '/inspections/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(modifierInspectionSchema),
  inspectionController.modifierInspection
);

// CAUSE DU CORRECTIF : seule écriture du module inspection dépourvue de
// `requireRole`. N'importe quel utilisateur authentifié de l'organisation —
// y compris `Client` (lecture/signatures/commentaires) et `Entreprise` —
// pouvait cocher ou décocher les points de contrôle d'une inspection, donc
// falsifier le résultat d'une OPR ou d'une visite contradictoire.
// Aligné sur le reste du module (création/modification d'inspection, modèles
// de checklist, convocations) : OPERATIONNEL_CONTROLE, qui inclut bien le
// bureau de contrôle — c'est précisément lui qui remplit les checklists.
router.patch(
  '/inspections/:id/checklist/:checklistId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(cocherChecklistSchema),
  inspectionController.cocherChecklist
);

router.delete(
  '/inspections/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  inspectionController.supprimerInspection
);

// ── Photos d'inspection (module 6) ───────────────────────────────────────────
router.post(
  '/inspections/:id/photos',
  auth,
  checkActiveUser,
  checkSubscription,
  upload.single('fichier'),
  upload.validateMagicBytes,
  mediaController.ajouterPhotoInspection
);

router.get('/inspections/:id/photos', auth, checkActiveUser, checkSubscription, paginate(), mediaController.listerPhotosInspection);

// ── Convocations (module 6) ──────────────────────────────────────────────────
router.get('/inspections/:id/convocations', auth, checkActiveUser, checkSubscription, paginate(), inspectionExtraController.listerConvocations);

router.post(
  '/inspections/:id/convocations',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(convierSchema),
  inspectionExtraController.convier
);

router.patch(
  '/inspections/:id/convocations/:convocationId',
  auth,
  checkActiveUser,
  checkSubscription,
  validate(repondreConvocationSchema),
  inspectionExtraController.repondreConvocation
);

router.delete(
  '/inspections/:id/convocations/:convocationId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  inspectionExtraController.retirerConvocation
);

// ── Application d'un modèle à une inspection existante (module 6) ────────────
router.post(
  '/inspections/:id/modele',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(appliquerModeleSchema),
  inspectionExtraController.appliquerModele
);

module.exports = router;
