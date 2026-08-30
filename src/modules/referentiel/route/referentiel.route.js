'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const referentielController = require('../controller/referentiel.controller.js');

/**
 * Référentiels techniques — énumérations métier.
 *
 * AUTHENTIFIÉ mais sans contrôle de rôle ni d'abonnement : ces listes sont la
 * grammaire de l'interface (statuts, sévérités, types). Les réserver à
 * certains rôles viderait les filtres et les badges de tout le monde, et rien
 * ici n'est confidentiel — ce sont les mêmes mots que ceux affichés à l'écran.
 *
 * Volontairement SÉPARÉ des référentiels ADMINISTRABLES (`/corps-etat`,
 * `/phases`, `/abonnement/plans`), qui vivent en base et ont leur propre CRUD.
 * Ici, rien ne s'écrit : ces valeurs sont des colonnes ENUM PostgreSQL, les
 * modifier demande une migration.
 */
router.get('/enums', auth, checkActiveUser, referentielController.getEnums);

module.exports = router;
