'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const uploadDocumentSchema = Joi.object({
  chantierId: uuid.required(),
  // Le type n'est plus énuméré ici : il vit dans un référentiel
  // administrable, et une liste figée empêcherait d'en ajouter. Seule la
  // FORME est contrôlée ; l'existence l'est par le middleware
  // `verifierTypeReferentiel`, posé sur la route.
  type: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50).optional(),

});

const signerDocumentSchema = Joi.object({
  donnees: Joi.any().optional(),
});

module.exports = { uploadDocumentSchema, signerDocumentSchema };
