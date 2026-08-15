'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const genererRapportSchema = Joi.object({
  chantierId: uuid.required(),
  type: Joi.string().valid('reserves', 'entreprise', 'batiment', 'qualite', 'visite', 'opr').optional(),
  statut: Joi.string().valid('creee', 'affectee', 'en_cours', 'corrigee', 'a_verifier', 'validee', 'refusee', 'rouverte', 'cloturee').optional(),
  entrepriseId: uuid.optional().allow(null),
  batimentId: uuid.optional().allow(null),
});

module.exports = { genererRapportSchema };
