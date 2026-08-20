'use strict';

const express = require('express');
const router = express.Router();
const demandeController = require('../controller/demandeInscription.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
// MFA obligatoire pour ce rôle (audit — Sécurité §3), comme les autres
// routes /admin/*.
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  validerDemandeSchema, rejeterDemandeSchema,
} = require('../validation/demandeInscription.validation.js');

// ── Demandes d'inscription (super-admin) ─────────────────────────────────────
// Chaîne identique aux autres routes admin : authentification, compte actif,
// rôle 'Admin', MFA active, limitation de débit.
const gardes = [auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit];

router.get('/', ...gardes, paginate(), demandeController.listerDemandes);

// Compteur pour la pastille du menu — déclaré AVANT '/:id', sinon Express
// interpréterait « en-attente » comme un identifiant.
router.get('/en-attente/compteur', ...gardes, demandeController.compterEnAttente);

router.get('/:id', ...gardes, demandeController.detailDemande);

router.post('/:id/valider', ...gardes, validate(validerDemandeSchema), demandeController.validerDemande);

router.post('/:id/rejeter', ...gardes, validate(rejeterDemandeSchema), demandeController.rejeterDemande);

module.exports = router;
