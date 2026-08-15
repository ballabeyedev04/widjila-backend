'use strict';

const Joi = require('joi');

const creerPartenaireSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(200).required(),
  type: Joi.string().valid(
    'client', 'maitre_ouvrage', 'maitre_oeuvre', 'sous_traitant',
    'fournisseur', 'bureau_controle', 'autre'
  ).optional().default('client'),
  email: Joi.string().email().optional().allow('', null),
  telephone: Joi.string().trim().max(50).optional().allow('', null),
  contact: Joi.string().trim().max(150).optional().allow('', null),
  adresse: Joi.string().trim().max(500).optional().allow('', null),
  notes: Joi.string().trim().max(2000).optional().allow('', null),
});

const modifierPartenaireSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(200).optional(),
  type: Joi.string().valid(
    'client', 'maitre_ouvrage', 'maitre_oeuvre', 'sous_traitant',
    'fournisseur', 'bureau_controle', 'autre'
  ).optional(),
  email: Joi.string().email().optional().allow('', null),
  telephone: Joi.string().trim().max(50).optional().allow('', null),
  contact: Joi.string().trim().max(150).optional().allow('', null),
  adresse: Joi.string().trim().max(500).optional().allow('', null),
  notes: Joi.string().trim().max(2000).optional().allow('', null),
}).min(1);

module.exports = { creerPartenaireSchema, modifierPartenaireSchema };
