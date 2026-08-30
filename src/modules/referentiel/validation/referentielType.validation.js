'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

/**
 * Référentiels de TYPE — documents, intervenants, inspections.
 *
 * `code` est bridé à `[a-z0-9_]` : ce n'est pas un libellé, c'est la valeur
 * écrite dans la colonne métier (`documents.type`…) et comparée par le code
 * applicatif. Y laisser passer des espaces ou des accents la rendrait
 * impossible à comparer de façon fiable, et l'ancien ENUM ne les acceptait
 * pas davantage.
 */
const CODE = Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50)
  .messages({
    'string.pattern.base':
      'Le code ne peut contenir que des lettres minuscules, des chiffres et des tirets bas',
  });

const creerTypeSchema = Joi.object({
  // REQUIS, contrairement aux corps d'état : c'est cette valeur qui est
  // stockée dans la donnée. Un type sans code ne pourrait être attribué.
  code: CODE.required(),
  nom: Joi.string().trim().min(2).max(100).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // Réservé au super-admin plateforme : le service ignore ce champ pour tout
  // autre rôle, qui crée forcément dans SA propre organisation.
  organisationId: uuid.optional().allow(null),
});

const modifierTypeSchema = Joi.object({
  // Accepté pour rendre un message d'erreur explicite plutôt qu'un rejet
  // « champ inconnu » : le service refuse tout code différent de l'actuel,
  // parce qu'il est déjà enregistré dans les données.
  code: CODE.optional(),
  nom: Joi.string().trim().min(2).max(100).optional(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // `.min(1)` : un PUT vide produirait un `update({})` silencieux, qui
  // répondrait « modifié » sans rien changer.
}).min(1);

const basculerActifTypeSchema = Joi.object({
  actif: Joi.boolean().required(),
});

module.exports = { creerTypeSchema, modifierTypeSchema, basculerActifTypeSchema };
