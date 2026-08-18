'use strict';

const express = require('express');
const router = express.Router();
const planController = require('../controller/plan.controller.js');
const annotationController = require('../controller/annotation.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { OPERATIONNEL, OPERATIONNEL_CONTROLE } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { uploadPlanSchema, creerAnnotationSchema, modifierAnnotationSchema } = require('../validation/plan.validation.js');

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
  requireRole(...OPERATIONNEL_CONTROLE),
  upload.single('fichier'),
  upload.validateMagicBytes,
  injectChantierId,
  validate(uploadPlanSchema),
  planController.uploaderPlan
);

// paginate() : plafonne page/limit avant que la query n'atteigne le service
// (voir pagination.middleware.js — `?limit=500000` chargeait tout le chantier).
router.get('/chantiers/:chantierId/plans', auth, checkActiveUser, checkSubscription, paginate(), planController.listerPlans);

// Liste TRANSVERSALE (tous chantiers) — onglet « Plans » de premier niveau.
router.get('/plans', auth, checkActiveUser, checkSubscription, planController.listerTousPlans);

router.get('/plans/:id', auth, checkActiveUser, checkSubscription, planController.detailPlan);

// ── Comparaison des versions d'un plan (module 4) ────────────────────────────
router.get('/plans/:id/versions', auth, checkActiveUser, checkSubscription, paginate(), annotationController.listerVersionsPlan);

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
  validate(creerAnnotationSchema),
  annotationController.creerAnnotation
);

router.put(
  '/annotations/:annotationId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
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

router.delete(
  '/plans/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  planController.supprimerPlan
);

module.exports = router;
