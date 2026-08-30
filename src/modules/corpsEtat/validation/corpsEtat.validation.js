'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

/**
 * Corps d'état — catalogue des métiers / types de travaux du BTP.
 *
 * `code` est bridé à `[a-z0-9_]` : c'est une clé technique, pas un libellé.
 * C'est elle qui fait le pont avec l'ancien ENUM `reserves.categorie` et qui
 * sert de repère stable quand le nom affiché change. Y laisser passer des
 * espaces ou des accents la rendrait impossible à comparer de façon fiable.
 */
const creerCorpsEtatSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(100).required(),
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50).optional().allow('', null)
    .messages({ 'string.pattern.base': 'Le code ne peut contenir que des lettres minuscules, des chiffres et des tirets bas' }),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // Réservé au super-admin plateforme : le service ignore ce champ pour tout
  // autre rôle, qui crée forcément dans SA propre organisation.
  organisationId: uuid.optional().allow(null),
});

const modifierCorpsEtatSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(100).optional(),
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50).optional().allow('', null)
    .messages({ 'string.pattern.base': 'Le code ne peut contenir que des lettres minuscules, des chiffres et des tirets bas' }),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // `.min(1)` : un PUT vide produirait un `update({})` silencieux, qui
  // répondrait « modifié » sans rien changer.
}).min(1);

const basculerActifSchema = Joi.object({
  actif: Joi.boolean().required(),
});

module.exports = { creerCorpsEtatSchema, modifierCorpsEtatSchema, basculerActifSchema };
