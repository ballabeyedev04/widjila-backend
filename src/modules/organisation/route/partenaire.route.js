'use strict';

const express = require('express');
const router = express.Router();
const partenaireController = require('../controller/partenaire.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { creerPartenaireSchema, modifierPartenaireSchema } = require('../validation/partenaire.validation.js');

// ── Partenaires (module 2) — clients, MOA, MOE, sous-traitants ───────────────
// paginate() : plafonne page/limit avant le service (voir pagination.middleware.js).
router.get('/organisation/partenaires', auth, checkActiveUser, checkSubscription, paginate(), partenaireController.listerPartenaires);

router.post(
  '/organisation/partenaires',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'ConducteurTravaux', 'MaitreOuvrage', 'MaitreOeuvre'),
  validate(creerPartenaireSchema),
  partenaireController.creerPartenaire
);

// Par chantier
router.get('/chantiers/:chantierId/partenaires', auth, checkActiveUser, checkSubscription, paginate(), partenaireController.listerPartenaires);

router.post(
  '/chantiers/:chantierId/partenaires',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'ConducteurTravaux', 'MaitreOuvrage', 'MaitreOeuvre'),
  validate(creerPartenaireSchema),
  partenaireController.creerPartenaire
);

router.put(
  '/partenaires/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet', 'ConducteurTravaux', 'MaitreOuvrage', 'MaitreOeuvre'),
  validate(modifierPartenaireSchema),
  partenaireController.modifierPartenaire
);

router.delete(
  '/partenaires/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole('ChefProjet'),
  partenaireController.supprimerPartenaire
);

module.exports = router;
