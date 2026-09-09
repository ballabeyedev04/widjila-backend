'use strict';

const Joi = require('joi');

/**
 * Création d'un code d'appartement depuis le « + » de la feuille de niveau.
 *
 * Le code est court et sans espace : c'est une étiquette lue d'un coup d'oeil
 * sur une porte (« A001 », « B12 »), pas une phrase. Le motif autorise
 * lettres, chiffres, `+` et `-` — le même que les codes de niveau, pour que
 * les deux référentiels se saisissent de la même façon.
 */
const creerCodeAppartementSchema = Joi.object({
  code: Joi.string().trim().min(1).max(20).pattern(/^[A-Za-z0-9+\-]+$/).required().messages({
    'string.pattern.base': 'Le code n\u2019accepte que des lettres, des chiffres, \u00ab + \u00bb et \u00ab - \u00bb.',
    'string.max': 'Le code ne peut pas d\u00e9passer 20 caract\u00e8res.',
    'any.required': 'Le code est obligatoire.',
  }),
  nom: Joi.string().trim().max(100).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(9999).optional(),
});

module.exports = { creerCodeAppartementSchema };
