'use strict';

const Joi = require('joi');
const { nom, prenom, email, telephone, uuid, role } = require('../../../validations/common.js');

const creerOrganisationSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).required(),
  raison_sociale: Joi.string().trim().max(255).optional().allow('', null),
  siret: Joi.string().trim().max(50).optional().allow('', null),
  num_tva: Joi.string().trim().max(50).optional().allow('', null),
  rccm: Joi.string().trim().max(50).optional().allow('', null),
  ninea: Joi.string().trim().alphanum().max(15).optional().allow('', null),
  telephone: telephone.optional().allow('', null),
  email: email.optional().allow('', null),
  adresse: Joi.string().trim().max(200).optional().allow('', null),
  ville: Joi.string().trim().max(100).optional().allow('', null),
  pays: Joi.string().trim().max(100).optional().allow('', null),
  abonnement: Joi.string().valid('Starter', 'Pro', 'Business', 'Enterprise').optional(),
});

const modifierOrganisationSchema = creerOrganisationSchema.fork(
  ['nom'],
  (field) => field.optional()
);

const ajouterMembreSchema = Joi.object({
  nom: nom.required(),
  prenom: prenom.required(),
  email: email.required(),
  mot_de_passe: Joi.string().min(8).max(128).optional(),
  telephone: telephone.optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  role: role.required(),
  permissions: Joi.array().items(Joi.string().trim()).optional(),
});

const modifierMembreSchema = Joi.object({
  nom: nom.optional(),
  prenom: prenom.optional(),
  telephone: telephone.optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  role: role.optional(),
  statut: Joi.string().valid('actif', 'inactif', 'en_attente_validation').optional(),
});

const creerEquipeSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(100).required(),
  description: Joi.string().trim().max(500).optional().allow('', null),
  membreIds: Joi.array().items(uuid).optional(),
});

module.exports = {
  creerOrganisationSchema,
  modifierOrganisationSchema,
  ajouterMembreSchema,
  modifierMembreSchema,
  creerEquipeSchema,
};
