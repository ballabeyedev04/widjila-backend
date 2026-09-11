'use strict';

const Joi = require('joi');
const { uuid, ROLE_UTILISATEUR, motDePasse } = require('../../../validations/common.js');

const creerUtilisateurAdminSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(50).required(),
  prenom: Joi.string().trim().min(2).max(50).required(),
  email: Joi.string().trim().email().lowercase().required(),
  // Même politique que partout ailleurs (majuscule, minuscule, chiffre) : un
  // mot de passe fixé par l'administration n'a aucune raison d'être plus
  // faible que celui qu'un utilisateur se choisit.
  mot_de_passe: motDePasse.optional(),
  telephone: Joi.string().pattern(/^\+?[0-9\s\-\.]{7,20}$/).optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  role: Joi.string().valid(...ROLE_UTILISATEUR).optional(),
  statut: Joi.string().valid('actif', 'inactif', 'en_attente_validation').optional(),
  organisationId: uuid.optional().allow(null),
});

const modifierUtilisateurAdminSchema = creerUtilisateurAdminSchema.fork(
  ['nom', 'prenom', 'email'],
  (f) => f.optional()
);

const changerRoleSchema = Joi.object({
  role: Joi.string().valid(...ROLE_UTILISATEUR).required(),
});

const modifierPermissionsSchema = Joi.object({
  permissions: Joi.array().items(Joi.string().trim()).required(),
});

const genererRapportSchema = Joi.object({
  chantierId: uuid.required(),
  type: Joi.string().valid('reserves', 'entreprise', 'batiment', 'qualite').optional(),
  statut: Joi.string().optional(),
  entrepriseId: uuid.optional().allow(null),
  batimentId: uuid.optional().allow(null),
});

module.exports = {
  creerUtilisateurAdminSchema,
  modifierUtilisateurAdminSchema,
  changerRoleSchema,
  modifierPermissionsSchema,
  genererRapportSchema,
};
