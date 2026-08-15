'use strict';

const express = require('express');
const router = express.Router();
const organisationController = require('../controller/organisation.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { mutationRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  modifierOrganisationSchema, ajouterMembreSchema, modifierMembreSchema, creerEquipeSchema,
} = require('../validation/organisation.validation.js');

const handleUpload = (req, res, next) => {
  upload.fields([{ name: 'logo', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: 'Erreur lors du traitement du fichier' });
    }
    upload.validateMagicBytes(req, res, next);
  });
};

// ── Organisation ─────────────────────────────────────────────────────────────
router.get('/', auth, checkActiveUser, checkSubscription, organisationController.monOrganisation);

// ── Filiales, agences & organigramme (module 2) ──────────────────────────────
router.get('/filiales', auth, checkActiveUser, checkSubscription, paginate(), organisationController.listerFiliales);

router.post(
  '/filiales',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.creerFiliale
);

router.post(
  '/filiales/:filialeId/agences',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.creerAgence
);

router.get('/organigramme', auth, checkActiveUser, checkSubscription, organisationController.organigramme);

// ── Import de contacts CSV (module 2) ────────────────────────────────────────
//
// CAUSE DU CORRECTIF : cette route acceptait un fichier de 10 MB (≈ 1,5 million
// de lignes) et n'avait AUCUN plafond de débit. Le service exécute pour chaque
// ligne un SELECT puis un `bcrypt.hash` à 12 rounds en JS pur (bcryptjs) — soit
// des centaines de millisecondes de CPU BLOQUANT PAR LIGNE, sur l'unique event
// loop du process. Une seule requête pouvait donc immobiliser toute l'API
// pendant plusieurs jours, et rien n'empêchait de la rejouer en boucle.
//
// Deux verrous posés ici :
//   1. `tableurUploadContacts` — plafond ramené de 10 MB à 512 KB (≈ 5 000 lignes) ;
//   2. `mutationRateLimit`     — 20 requêtes / 15 min par IP.
// ⚠️ Le VRAI plafond (nombre de lignes réellement traitées + hachage hors boucle
// bloquante) doit être posé dans le service — voir le rapport de correctifs.
router.post(
  '/membres/import',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  mutationRateLimit,
  upload.tableurUploadContacts.single('fichier'),
  upload.validateTableurMagicBytes,
  organisationController.importContacts
);

router.put(
  '/',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  handleUpload,
  validate(modifierOrganisationSchema),
  organisationController.modifierOrganisation
);

// ── Membres ──────────────────────────────────────────────────────────────────
// Liste des membres : réservée aux rôles gestionnaires (voir aussi
// GET / qui renvoie les membres de l'org avec des attributs sûrs).
router.get('/membres', auth, checkActiveUser, checkSubscription, requireRole(...GESTION), paginate(), organisationController.listerMembres);

router.post(
  '/membres',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(ajouterMembreSchema),
  organisationController.ajouterMembre
);

router.put(
  '/membres/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(modifierMembreSchema),
  organisationController.modifierMembre
);

router.delete(
  '/membres/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.supprimerMembre
);

// ── Équipes ──────────────────────────────────────────────────────────────────
router.get('/equipes', auth, checkActiveUser, checkSubscription, paginate(), organisationController.listerEquipes);

router.post(
  '/equipes',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  validate(creerEquipeSchema),
  organisationController.creerEquipe
);

router.post(
  '/equipes/:id/membres',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.ajouterMembreEquipe
);

router.delete(
  '/equipes/:id/membres/:membreId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.retirerMembreEquipe
);

router.delete(
  '/equipes/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...GESTION),
  organisationController.supprimerEquipe
);

module.exports = router;
