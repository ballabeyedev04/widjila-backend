'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controller/suppressionCompte.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const requireMfaActive = require('../../../middlewares/requireMfaActive.middleware.js');
const { adminRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { traiterDemandeSchema } = require('../validation/suppressionCompte.validation.js');

// Chaîne de gardes identique aux autres routes /admin/* : authentification,
// compte actif, rôle 'Admin', MFA active, limitation de débit.
const gardes = [auth, checkActiveUser, requireRole('Admin'), requireMfaActive, adminRateLimit];

router.get('/', ...gardes, paginate(), controller.listerDemandes);

// Déclaré AVANT '/:id' — sinon Express lirait « en-attente » comme un id.
router.get('/en-attente/compteur', ...gardes, controller.compterEnAttente);

router.patch('/:id', ...gardes, validate(traiterDemandeSchema), controller.traiterDemande);

module.exports = router;
