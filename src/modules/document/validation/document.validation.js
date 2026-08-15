'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const uploadDocumentSchema = Joi.object({
  chantierId: uuid.required(),
  type: Joi.string().valid('plan', 'contrat', 'doe', 'pv', 'compte_rendu', 'rapport', 'notice', 'photo', 'autre').optional(),
});

const signerDocumentSchema = Joi.object({
  donnees: Joi.any().optional(),
});

module.exports = { uploadDocumentSchema, signerDocumentSchema };
