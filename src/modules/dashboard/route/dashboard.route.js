'use strict';

const express = require('express');
const router = express.Router();
const dashboardController = require('../controller/dashboard.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');

// ── Tableau de bord ──────────────────────────────────────────────────────────
router.get('/', auth, checkActiveUser, checkSubscription, dashboardController.statsGlobales);

router.get('/chantiers/:chantierId', auth, checkActiveUser, checkSubscription, dashboardController.statsChantier);

// ── Module 9 — KPI avancés ───────────────────────────────────────────────────
router.get('/par-entreprise', auth, checkActiveUser, checkSubscription, dashboardController.statsParEntreprise);

router.get('/chantiers/:chantierId/par-batiment', auth, checkActiveUser, checkSubscription, dashboardController.statsParBatiment);

router.get('/chantiers/:chantierId/duree-traitement', auth, checkActiveUser, checkSubscription, dashboardController.dureeTraitement);

router.get('/chantiers/:chantierId/productivite', auth, checkActiveUser, checkSubscription, dashboardController.productivite);

router.get('/chantiers/:chantierId/evolution', auth, checkActiveUser, checkSubscription, dashboardController.evolution);

router.get('/export', auth, checkActiveUser, checkSubscription, dashboardController.exportExcel);

module.exports = router;
