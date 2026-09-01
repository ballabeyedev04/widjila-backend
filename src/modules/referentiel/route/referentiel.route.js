'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const referentielController = require('../controller/referentiel.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const { creerCodeNiveauSchema } = require('../validation/codeNiveau.validation.js');

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
// PUBLIQUE — c'est le formulaire d'INSCRIPTION qui la consomme, et son
// utilisateur n'a pas encore de session. Aucune donnée sensible : ce sont les
// noms des administrations fiscales de quatre pays.
router.get('/pays', referentielController.getPays);

router.get('/enums', auth, checkActiveUser, referentielController.getEnums);

// ── Codes de niveau — SS1, RDC, R+1… ─────────────────────────────────────────
//
// Ce référentiel-ci vit en BASE et s'écrit, contrairement aux énumérations
// ci-dessus. Il est ici parce que c'est là que les clients vont chercher
// « la liste des codes », et non dans un module à part.
//
// Aucun `requireRole` sur la lecture NI sur la création : le client a demandé
// que l'entreprise qui dépose ses plans puisse créer un code absent, et
// l'entreprise est justement le rôle exclu de tous les groupes de gestion. La
// garde qui compte est dans le service — le code créé appartient à
// l'organisation de l'appelant, jamais au catalogue standard.
router.get('/codes-niveau', auth, checkActiveUser, referentielController.listerCodesNiveau);
router.post('/codes-niveau', auth, checkActiveUser, validate(creerCodeNiveauSchema), referentielController.creerCodeNiveau);

// La DÉSACTIVATION, elle, reste un geste d'administration du référentiel.
router.delete('/codes-niveau/:id', auth, checkActiveUser, requireRole(...GESTION), referentielController.desactiverCodeNiveau);

module.exports = router;
