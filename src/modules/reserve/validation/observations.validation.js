'use strict';

const Joi = require('joi');

/**
 * `GET /reserves/observations` — observations déjà saisies par l'utilisateur,
 * proposées en suggestions dans le champ « Observation » de la création d'une
 * réserve (mobile).
 *
 *   q      texte en cours de saisie (facultatif) — filtre insensible à la casse
 *          et aux accents, sur le début de l'observation ou de ses mots ;
 *   limit  nombre maximal de suggestions renvoyées.
 */
const suggestionsObservationSchema = Joi.object({
  q: Joi.string().trim().max(200).optional().allow(''),
  limit: Joi.number().integer().min(1).max(200).optional().default(50),
});

module.exports = { suggestionsObservationSchema };
