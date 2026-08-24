'use strict';

const Joi = require('joi');
const { email } = require('../../../validations/common.js');

/**
 * Dépôt public — aucune authentification.
 *
 * Les bornes ne sont pas cosmétiques : cette route est ouverte à Internet.
 * Sans `.max()` sur `objet`, n'importe qui posterait un mégaoctet de texte à
 * chaque requête, et la table grossirait sans limite.
 */
const creerDemandeSchema = Joi.object({
  email: email.required(),
  objet: Joi.string().trim().min(10).max(2000).required().messages({
    'string.min': "L'objet doit contenir au moins 10 caractères",
    'string.max': "L'objet ne peut pas dépasser 2000 caractères",
    'any.required': "L'objet de la demande est obligatoire",
  }),
});

/** Filtres de la liste admin. */
const listerDemandesSchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  search: Joi.string().trim().max(200).optional().allow(''),
  statut: Joi.string().valid('en_attente', 'traitee', 'rejetee').optional().allow(''),
});

/** Décision de l'admin sur une demande. */
const traiterDemandeSchema = Joi.object({
  statut: Joi.string().valid('traitee', 'rejetee').required(),
  note_admin: Joi.string().trim().max(2000).optional().allow('', null),
});

module.exports = { creerDemandeSchema, listerDemandesSchema, traiterDemandeSchema };
