'use strict';

const Joi = require('joi');
const { ROLE_UTILISATEUR } = require('../../../validations/common.js');

/**
 * Le rôle définitif est choisi par l'admin au moment de valider. 'Admin' en est
 * exclu : le super-admin plateforme ne se recrute pas par formulaire
 * d'inscription publique — ce serait une escalade de privilèges à un clic.
 */
const ROLES_ATTRIBUABLES = ROLE_UTILISATEUR.filter((r) => r !== 'Admin');

const validerDemandeSchema = Joi.object({
  role: Joi.string().valid(...ROLES_ATTRIBUABLES).optional(),
});

const rejeterDemandeSchema = Joi.object({
  // Obligatoire, et pas seulement « recommandé » : le motif est l'unique
  // explication que recevra le demandeur. Un rejet sans motif produirait un
  // email vide de sens.
  motif: Joi.string().trim().min(5).max(1000).required().messages({
    'string.empty': 'Le motif du rejet est obligatoire',
    'any.required': 'Le motif du rejet est obligatoire',
    'string.min': 'Le motif doit faire au moins 5 caractères',
    'string.max': 'Le motif ne peut pas dépasser 1000 caractères',
  }),
});

module.exports = { validerDemandeSchema, rejeterDemandeSchema, ROLES_ATTRIBUABLES };
