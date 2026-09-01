'use strict';

const Joi = require('joi');
const { TYPE_NIVEAU } = require('../../../config/enums.js');

/**
 * Création d'un code de niveau depuis le « + » de l'écran de dépôt.
 *
 * Le code est court et sans espace : c'est une étiquette lue d'un coup d'œil
 * sur un plan (« SS1 », « R+12 »), pas une phrase. Le motif autorise lettres,
 * chiffres, `+` et `-` — de quoi écrire « R+1 » et « N-2 », sans laisser
 * passer une description entière qui rendrait la liste illisible.
 */
const creerCodeNiveauSchema = Joi.object({
  typeNiveau: Joi.string().valid(...TYPE_NIVEAU).required().messages({
    'any.only': 'Le type de niveau doit être un sous-sol, un étage ou une toiture.',
    'any.required': 'Le type de niveau est obligatoire.',
  }),
  code: Joi.string().trim().min(1).max(20).pattern(/^[A-Za-z0-9+\-]+$/).required().messages({
    'string.pattern.base': 'Le code n’accepte que des lettres, des chiffres, « + » et « - ».',
    'string.max': 'Le code ne peut pas dépasser 20 caractères.',
    'any.required': 'Le code est obligatoire.',
  }),
  nom: Joi.string().trim().max(100).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(9999).optional(),
});

module.exports = { creerCodeNiveauSchema };
