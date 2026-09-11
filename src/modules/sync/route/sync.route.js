'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { syncReservesQuery } = require('../validation/sync.validation.js');
const syncController = require('../controller/sync.controller.js');

/**
 * Synchronisation hors ligne du mobile — lecture seule.
 *
 * Mêmes gardes que `GET /reserves` (liste transversale) : ce tirage sert
 * exactement le même périmètre, page par page, avec les suppressions en plus.
 */
router.get('/sync/reserves', auth, checkActiveUser, checkSubscription, validate(syncReservesQuery, 'query'), syncController.reserves);

module.exports = router;
