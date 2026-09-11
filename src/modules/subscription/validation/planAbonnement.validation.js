'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');
const { CODES } = require('../../../config/fonctionnalites.js');

/**
 * Catalogue des formules — administration.
 *
 * `prix` accepte explicitement `null` : c'est ainsi qu'on déclare une formule
 * « sur devis ». Une valeur nulle et l'absence du champ n'ont pas le même
 * sens à la modification (effacer le prix vs ne pas y toucher), d'où la
 * distinction faite dans le service.
 */
const creerPlanSchema = Joi.object({
  // Clé technique stable, servant de référence dans l'historique : minuscules
  // et tirets bas uniquement, comme les autres codes du projet.
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50).required()
    .messages({ 'string.pattern.base': 'Le code ne peut contenir que des lettres minuscules, des chiffres et des tirets bas' }),
  nom: Joi.string().trim().min(2).max(100).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  // `null` = sur devis.
  prix: Joi.number().min(0).max(1000000).precision(2).optional().allow(null, ''),
  devise: Joi.string().trim().uppercase().length(3).optional(),
  periode: Joi.string().valid('mois', 'an').optional(),
  // `null` = illimité, jamais -1 : une sentinelle obligerait chaque calcul à
  // la connaître.
  limiteUtilisateurs: Joi.number().integer().min(1).max(100000).optional().allow(null),
  limiteChantiers: Joi.number().integer().min(1).max(100000).optional().allow(null),
  // Seuls les codes du catalogue sont acceptés : un code libre donnerait
  // l'illusion d'avoir accordé une option qui n'existe pas.
  fonctionnalites: Joi.array().items(Joi.string().valid(...CODES)).optional(),
  stripePriceId: Joi.string().trim().max(100).optional().allow('', null),
  actif: Joi.boolean().optional(),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
});

// Le CODE n'est pas modifiable : il sert de clé dans l'historique des
// souscriptions, le renommer orphelinerait les lignes enregistrées.
const modifierPlanSchema = creerPlanSchema.fork(['code', 'nom'], (f) => f.optional())
  .fork(['code'], (f) => f.forbidden())
  .min(1);

const basculerActifPlanSchema = Joi.object({
  actif: Joi.boolean().required(),
});

/** Activation manuelle d'une formule « sur devis » par le super-admin. */
const activerManuellementSchema = Joi.object({
  organisationId: uuid.required(),
  planId: Joi.string().trim().max(100).required(), // id OU code
  // Prix négocié : c'est LUI qui fait foi dans l'historique, pas le catalogue.
  prix: Joi.number().min(0).max(1000000).precision(2).optional().allow(null),
  periode: Joi.string().valid('mois', 'an').optional(),
  // Dans le FUTUR : une fin passée créait une souscription « active » dont la
  // période est inversée (début = maintenant). La base la refuse désormais
  // (contrainte `abonnements_souscrits_periode_ordonnee`) — mieux vaut un 400
  // explicite ici qu'une erreur de base en 500.
  dateFin: Joi.date().iso().greater('now').optional().allow(null)
    .messages({ 'date.greater': 'La date de fin doit être dans le futur.' }),
  note: Joi.string().trim().max(2000).optional().allow('', null),
});

module.exports = {
  creerPlanSchema,
  modifierPlanSchema,
  basculerActifPlanSchema,
  activerManuellementSchema,
};
