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
  // Un partenaire est actif à la création : le champ n'est accepté que pour
  // permettre à un import ou à une reprise de données de créer directement
  // une fiche archivée.
  actif: Joi.boolean().optional(),
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
  // Bascule activer / désactiver — voir `actif` dans partenaire.model.js.
  actif: Joi.boolean().optional(),
}).min(1);

module.exports = { creerPartenaireSchema, modifierPartenaireSchema };
