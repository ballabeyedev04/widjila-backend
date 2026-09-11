'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controller/reports.controller.js');
const { requireFonctionnalite } = require('../../../middlewares/requireFonctionnalite.middleware.js');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { envoiRapportRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const { OPERATIONNEL, PILOTAGE } = require('../../../config/roles.js');
const {
  creerRapportSchema, modifierRapportSchema, listerRapportsQuery, telechargerQuery,
  previsualiserQuery, envoyerRapportSchema, partagerRapportSchema,
} = require('../validation/rapport.validation.js');

/**
 * Routes du module Rapports — § 9 du cahier des charges.
 *
 * ── Qui peut quoi (§ 21, « autorisations par projet et rôle ») ─────────────
 *
 *  - LIRE (liste, détail, téléchargement, historique) : tout membre actif de
 *    l'organisation. Un rapport déjà produit appartient au client ; le lui
 *    fermer après coup effacerait une pièce qu'il a payée.
 *  - PRODUIRE ET DIFFUSER (créer, générer, envoyer, partager) : `PILOTAGE`.
 *    Diffuser un rapport de réserves à des tiers engage l'organisation.
 *  - SUPPRIMER : `OPERATIONNEL`, comme pour l'ancien point d'entrée.
 *
 * La génération et la prévisualisation exigent en plus la fonctionnalité
 * « rapports » de la formule : ce sont elles qui coûtent (composition du PDF).
 *
 * Le cloisonnement entre organisations est tenu par le SERVICE, à chaque
 * lecture : un identifiant de rapport d'un autre chantier répond « introuvable »
 * (§ 21, « protection contre l'accès à un autre chantier par modification
 * d'identifiant »).
 *
 * Les gardes sont regroupées dans des constantes `gardes…` qui portent
 * `auth` en toutes lettres : c'est ce que `routes.authRequise.test.js` sait
 * lire, et ce qui rend un oubli d'authentification impossible à commettre
 * sans que la suite de tests ne le signale.
 */

const router = express.Router();

const gardesMembre = [auth, checkActiveUser, checkSubscription];
const gardesPilote = [auth, checkActiveUser, checkSubscription, requireRole(...PILOTAGE)];
const gardesProducteur = [
  auth, checkActiveUser, checkSubscription, requireFonctionnalite('rapports'), requireRole(...PILOTAGE),
];

// ── Modèles (§ 5) ────────────────────────────────────────────────────────────
router.get('/reports/modeles', ...gardesMembre, controller.modeles);

// ── Configuration ────────────────────────────────────────────────────────────
router.post('/reports', ...gardesProducteur, validate(creerRapportSchema), controller.creer);
router.get('/reports', ...gardesMembre, validate(listerRapportsQuery, 'query'), controller.lister);
router.get('/reports/:id', ...gardesMembre, controller.detail);
router.patch('/reports/:id', ...gardesPilote, validate(modifierRapportSchema), controller.modifier);

// ── Génération (§ 11, § 15, § 20) ────────────────────────────────────────────
router.post('/reports/:id/generate', ...gardesProducteur, controller.generer);
router.post('/reports/:id/generate-by-company', ...gardesProducteur, controller.genererParEntreprise);
router.get(
  '/reports/:id/preview',
  ...gardesMembre, requireFonctionnalite('rapports'),
  validate(previsualiserQuery, 'query'),
  controller.previsualiser,
);
router.get('/reports/:id/download', ...gardesMembre, validate(telechargerQuery, 'query'), controller.telecharger);

// ── Diffusion (§ 13, § 14) ───────────────────────────────────────────────────
//
// La PRÉPARATION de l'envoi a les mêmes droits que l'envoi : elle expose les
// adresses des entreprises et des clients du chantier.
router.get('/reports/:id/send-email', ...gardesPilote, controller.preparerEnvoi);
router.post('/reports/:id/send-email', ...gardesPilote, envoiRapportRateLimit, validate(envoyerRapportSchema), controller.envoyer);
router.get('/reports/:id/recipients', ...gardesMembre, controller.destinataires);

router.post('/reports/:id/share', ...gardesPilote, validate(partagerRapportSchema), controller.partager);
router.get('/reports/:id/shares', ...gardesPilote, controller.listerPartages);
router.delete('/reports/:id/shares/:partageId', ...gardesPilote, controller.revoquerPartage);

// ── Historique, duplication, archivage (§ 18, § 19) ──────────────────────────
router.get('/reports/:id/history', ...gardesMembre, controller.historique);
router.post('/reports/:id/duplicate', ...gardesPilote, controller.dupliquer);
router.post('/reports/:id/archive', ...gardesPilote, controller.archiver);
router.delete('/reports/:id', ...gardesMembre, requireRole(...OPERATIONNEL), controller.supprimer);

/* ══════════════════════════════════════════════════════════════════════════
   § 14 — Le lien sécurisé, PUBLIC par nature
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Authentification FACULTATIVE.
 *
 * Un lien de partage s'ouvre sans compte — c'est son objet. Mais le § 14
 * prévoit qu'il puisse être « protégé par authentification » : quand le
 * client envoie un jeton, il est vérifié exactement comme ailleurs (et un
 * jeton invalide est refusé, pas ignoré) ; quand il n'en envoie pas, la
 * requête continue sans utilisateur, et c'est le service qui décide si ce
 * lien-là l'exige.
 */
const authSiPresente = (req, res, next) => {
  if (!req.headers.authorization) return next();
  // Un jeton présenté est contrôlé JUSQU'AU BOUT : `auth` seul ne refuse que
  // les comptes « inactif ». Un compte rejeté ou en attente aurait ouvert un
  // lien protégé de son (ancienne) organisation.
  return auth(req, res, (err) => (err ? next(err) : checkActiveUser(req, res, next)));
};

/**
 * Limite dédiée aux liens publics.
 *
 * Un jeton de 256 bits ne se devine pas ; la limite ne protège donc pas le
 * secret, elle protège le SERVEUR — chaque ouverture relit un PDF depuis le
 * stockage, et un lien diffusé par erreur sur un forum ne doit pas suffire à
 * saturer la bande passante.
 */
const limiteLienPublic = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const lienPublic = [limiteLienPublic, authSiPresente, controller.ouvrirLienPublic];
router.get('/r/:token', ...lienPublic);

module.exports = router;
module.exports.lienPublic = lienPublic;
