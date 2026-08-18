'use strict';

const express = require('express');
const router = express.Router();
const reserveController = require('../controller/reserve.controller.js');
const reserveExtraController = require('../controller/reserveExtra.controller.js');
const reserveExcelController = require('../controller/reserveExcel.controller.js');
const mediaController = require('../../media/controller/media.controller.js');
const upload = require('../../../middlewares/upload.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { mutationRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const { OPERATIONNEL, OPERATIONNEL_CONTROLE, RESERVE_INTERVENANTS } = require('../../../config/roles.js');
const validate = require('../../../middlewares/validate.middleware.js');
const {
  creerReserveSchema, modifierReserveSchema, changerStatutReserveSchema, ajouterCommentaireSchema,
  creerSerieReservesSchema, signerReserveSchema, affecterReserveSchema,
} = require('../validation/reserve.validation.js');

// Le chantierId est porté par l'URL → injecté dans le body avant validation Joi
const injectChantierId = (req, res, next) => {
  req.body.chantierId = req.params.chantierId;
  next();
};

// ── Réserves ─────────────────────────────────────────────────────────────────
// paginate() : plafonne page/limit — `listerReserves` empile une dizaine de
// jointures (batiment, etage, zone, lot, entreprise, assigne, medias...),
// `?limit=500000` suffisait à saturer la base et la RAM du process.
router.get('/chantiers/:chantierId/reserves', auth, checkActiveUser, checkSubscription, paginate(), reserveController.listerReserves);

router.post(
  '/chantiers/:chantierId/reserves',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  injectChantierId,
  validate(creerReserveSchema),
  reserveController.creerReserve
);

// Liste TRANSVERSALE (tous chantiers de l'organisation) — écran « Réserves »
// de premier niveau côté mobile. Déclarée avant `/reserves/:id` par lisibilité :
// les deux motifs ne se recouvrent pas (`:id` exige un segment), l'ordre n'est
// donc pas fonctionnellement nécessaire ici.
router.get('/reserves', auth, checkActiveUser, checkSubscription, paginate(), reserveController.listerToutesReserves);

router.get('/reserves/:id', auth, checkActiveUser, checkSubscription, reserveController.detailReserve);

router.put(
  '/reserves/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  validate(modifierReserveSchema),
  reserveController.modifierReserve
);

router.patch(
  '/reserves/:id/statut',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  validate(changerStatutReserveSchema),
  reserveController.changerStatut
);

router.delete(
  '/reserves/:id',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  reserveController.supprimerReserve
);

// ── Série de réserves & duplication (module 5) ──────────────────────────────
router.post(
  '/chantiers/:chantierId/reserves/serie',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  injectChantierId,
  validate(creerSerieReservesSchema),
  reserveController.creerSerieReserves
);

router.post(
  '/reserves/:id/dupliquer',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  reserveController.dupliquerReserve
);

// ── Pièces jointes (module 5) ────────────────────────────────────────────────
router.post(
  '/reserves/:id/pieces',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  upload.single('fichier'),
  upload.validateMagicBytes,
  reserveExtraController.ajouterPieceJointe
);

router.get('/reserves/:id/pieces', auth, checkActiveUser, checkSubscription, paginate(), reserveExtraController.listerPiecesJointes);

router.delete(
  '/reserves/pieces/:pieceId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  reserveExtraController.supprimerPieceJointe
);

// ── Signatures électroniques (module 5) ──────────────────────────────────────
router.post(
  '/reserves/:id/signatures',
  auth,
  checkActiveUser,
  checkSubscription,
  validate(signerReserveSchema),
  reserveExtraController.signerReserve
);

router.get('/reserves/:id/signatures', auth, checkActiveUser, checkSubscription, paginate(), reserveExtraController.listerSignatures);

// ── Affectations multiples (module 5) ────────────────────────────────────────
router.post(
  '/reserves/:id/affectations',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  validate(affecterReserveSchema),
  reserveExtraController.affecterIntervenant
);

router.get('/reserves/:id/affectations', auth, checkActiveUser, checkSubscription, paginate(), reserveExtraController.listerAffectations);

router.delete(
  '/reserves/:id/affectations/:affectationId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  reserveExtraController.retirerAffectation
);

// ── QR code (module 5) ───────────────────────────────────────────────────────
router.get('/reserves/:id/qr', auth, checkActiveUser, checkSubscription, reserveExtraController.genererQr);

// ── Import / export Excel (module 5) ─────────────────────────────────────────
router.get(
  '/chantiers/:chantierId/reserves/export',
  auth,
  checkActiveUser,
  checkSubscription,
  reserveExcelController.exporterExcel
);

// `mutationRateLimit` (20 req / 15 min) : l'import déclenche une décompression
// ExcelJS complète en mémoire puis un INSERT par ligne. Sans plafond de débit,
// la route se rejouait en boucle — même avec un fichier de taille légitime.
router.post(
  '/chantiers/:chantierId/reserves/import',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL_CONTROLE),
  mutationRateLimit,
  upload.tableurUpload.single('fichier'),
  upload.validateTableurMagicBytes,
  reserveExcelController.importerExcel
);

// ── Commentaires ─────────────────────────────────────────────────────────────
router.post(
  '/reserves/:id/commentaires',
  auth,
  checkActiveUser,
  checkSubscription,
  validate(ajouterCommentaireSchema),
  reserveController.ajouterCommentaire
);

router.get('/reserves/:id/commentaires', auth, checkActiveUser, checkSubscription, paginate(), reserveController.listerCommentaires);

// ── Médias (photo / vidéo / note vocale) ─────────────────────────────────────
// Chaque média est horodaté (pris_le) et rattaché à sa réserve.
//
// CAUSE DU CORRECTIF : le dépôt de média n'avait aucun `requireRole`, contrairement
// à toutes les autres routes d'intervention du module. Ce n'est pas qu'un dépôt de
// fichier : la règle métier « preuves de correction obligatoires » compte les médias
// attachés à la réserve pour autoriser le passage en corrigee/validee. N'importe
// quel rôle — `Client` compris — pouvait donc DÉBLOQUER LA VALIDATION d'une réserve
// en y déposant une image quelconque. Aligné sur POST /reserves, PATCH /statut et
// POST /pieces : RESERVE_INTERVENANTS (inclut `Entreprise`, qui exécute les travaux
// et doit pouvoir photographier ses corrections).
// `upload.media` (et non `upload`) : plafond de taille adapté aux vidéos.
router.post(
  '/reserves/:id/medias',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...RESERVE_INTERVENANTS),
  upload.media.single('fichier'),
  upload.validateMagicBytes,
  mediaController.ajouterMedia
);

router.get('/reserves/:id/medias', auth, checkActiveUser, checkSubscription, paginate(), mediaController.listerMedias);

router.delete(
  '/medias/:mediaId',
  auth,
  checkActiveUser,
  checkSubscription,
  requireRole(...OPERATIONNEL),
  mediaController.supprimerMedia
);

module.exports = router;
