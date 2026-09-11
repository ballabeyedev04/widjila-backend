'use strict';

const express = require('express');
const router = express.Router();
const supportController = require('../controller/support.controller.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const { mutationRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { envoyerMessageSupportSchema } = require('../validation/support.validation.js');

// ── Contact du support depuis l'application ─────────────────────────────────
// Pas de `checkSubscription` : un abonnement échu est justement l'une des
// raisons d'écrire au support. `mutationRateLimit` borne les envois — un
// formulaire relancé en boucle ne doit pas inonder la boîte du support.
router.post(
  '/messages',
  auth,
  checkActiveUser,
  mutationRateLimit,
  validate(envoyerMessageSupportSchema),
  supportController.envoyerMessage
);

module.exports = router;
