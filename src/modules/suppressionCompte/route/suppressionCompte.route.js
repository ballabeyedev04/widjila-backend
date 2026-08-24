'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controller/suppressionCompte.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { authRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const { creerDemandeSchema } = require('../validation/suppressionCompte.validation.js');

/**
 * Route PUBLIQUE de dépôt — exigence Google Play : l'URL doit être accessible
 * sans connexion et sans avoir l'application installée.
 *
 * `authRateLimit` et non `mutationRateLimit` : c'est le seuil le plus strict du
 * projet, et il est justifié ici — la route est ouverte à Internet, non
 * authentifiée, et déclenche un envoi d'email à chaque appel. Sans cela, elle
 * servirait de relais pour inonder la boîte de l'équipe.
 */
router.post('/', authRateLimit, validate(creerDemandeSchema), controller.creerDemande);

module.exports = router;
