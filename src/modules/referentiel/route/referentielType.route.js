'use strict';

const express = require('express');
const auth = require('../../../middlewares/auth.middleware.js');
const checkActiveUser = require('../../../middlewares/checkActiveUser.middleware.js');
const checkSubscription = require('../../../middlewares/checkSubscription.middleware.js');
const requireRole = require('../../../middlewares/requireRole.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { GESTION } = require('../../../config/roles.js');
const {
  creerTypeSchema, modifierTypeSchema, basculerActifTypeSchema,
} = require('../validation/referentielType.validation.js');

/**
 * Routeur générique d'un référentiel de TYPE.
 *
 * LECTURE ouverte à tout membre authentifié : choisir le type d'un document
 * fait partie du travail courant, pas de l'administration. C'est la raison
 * d'être de `/actifs`, que consomment les listes déroulantes du web et du
 * mobile.
 *
 * ÉCRITURE sur GESTION — le même groupe que l'organisation, les équipes et
 * les corps d'état : un référentiel est une donnée de référence de
 * l'entreprise, au même titre que son organigramme. La garde FINE (ne pas
 * toucher au catalogue standard, ni à celui d'une autre organisation) vit
 * dans le service.
 *
 * @param {object} controleur handlers produits par `creerControleur`
 */
function creerRouteur(controleur) {
  const router = express.Router();

  // ── Lecture ────────────────────────────────────────────────────────────
  // `/actifs` AVANT `/:id` : sans cela, « actifs » serait interprété comme un
  // identifiant et la route ne répondrait jamais.
  router.get('/actifs', auth, checkActiveUser, checkSubscription, controleur.listerActifs);

  router.get('/', auth, checkActiveUser, checkSubscription, paginate(), controleur.lister);

  router.get('/:id', auth, checkActiveUser, checkSubscription, controleur.detail);

  // ── Écriture ───────────────────────────────────────────────────────────
  router.post(
    '/',
    auth,
    checkActiveUser,
    checkSubscription,
    requireRole(...GESTION),
    validate(creerTypeSchema),
    controleur.creer
  );

  router.put(
    '/:id',
    auth,
    checkActiveUser,
    checkSubscription,
    requireRole(...GESTION),
    validate(modifierTypeSchema),
    controleur.modifier
  );

  // Geste courant du catalogue : retirer un type de la liste proposée sans
  // toucher aux enregistrements qui le portent déjà.
  router.patch(
    '/:id/actif',
    auth,
    checkActiveUser,
    checkSubscription,
    requireRole(...GESTION),
    validate(basculerActifTypeSchema),
    controleur.basculerActif
  );

  // Refusée dès qu'un enregistrement porte ce code — voir le service.
  router.delete(
    '/:id',
    auth,
    checkActiveUser,
    checkSubscription,
    requireRole(...GESTION),
    controleur.supprimer
  );

  return router;
}

module.exports = creerRouteur;
