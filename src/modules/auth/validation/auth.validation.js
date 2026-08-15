'use strict';

const Joi = require('joi');
const { telephone, motDePasse, nom, prenom, email } = require('../../../validations/common.js');

const registerSchema = Joi.object({
  // Utilisateur
  nom: nom.required(),
  prenom: prenom.required(),
  email: email.required(),
  mot_de_passe: motDePasse.required(),
  telephone: telephone.optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  // Organisation (entreprise) créée à l'inscription
  organisationNom: Joi.string().trim().min(2).max(150).optional().allow('', null),
  raison_sociale: Joi.string().trim().max(255).optional().allow('', null),
  siret: Joi.string().trim().max(50).optional().allow('', null),
  rccm: Joi.string().trim().max(50).optional().allow('', null),
  ninea: Joi.string().trim().alphanum().max(15).optional().allow('', null),
  organisationTelephone: telephone.optional().allow('', null),
  organisationEmail: email.optional().allow('', null),
  organisationAdresse: Joi.string().trim().max(200).optional().allow('', null),
  organisationVille: Joi.string().trim().max(100).optional().allow('', null),
  organisationPays: Joi.string().trim().max(100).optional().allow('', null),
});

const loginSchema = Joi.object({
  // Les bornes ne sont pas cosmétiques : sans `.max()`, une chaîne de 250 000
  // caractères atteignait la regex de détection d'email du service et bloquait
  // la boucle d'événements plusieurs minutes (ReDoS non authentifié).
  // 320 = longueur maximale d'une adresse email (RFC 5321).
  identifiant: Joi.string().trim().max(320).required(),
  mot_de_passe: Joi.string().max(128).required(),
});

// refreshToken : désormais porté par le cookie httpOnly (le body n'est qu'un
// fallback de compat) — donc optionnel dans le schéma.
const refreshSchema = Joi.object({
  refreshToken: Joi.string().optional().allow('', null),
});

const logoutSchema = Joi.object({
  refreshToken: Joi.string().optional().allow('', null),
});

// Validation du code TOTP (2e facteur) après un login MFA.
// mfaToken : porté par le cookie httpOnly (fallback body pour compat).
const mfaVerifySchema = Joi.object({
  mfaToken: Joi.string().optional().allow('', null),
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Le code de vérification doit contenir 6 chiffres',
  }),
});

// Vérification de l'email d'inscription (lien signé)
const verifyEmailSchema = Joi.object({
  token: Joi.string().required(),
});

const forgotPasswordSchema = Joi.object({
  email: email.required(),
});

const resetPasswordSchema = Joi.object({
  otp: Joi.string().trim().min(6).max(6).required(),
  email: email.required(),
  nouveau_mot_de_passe: motDePasse.required(),
});

module.exports = {
  registerSchema, loginSchema, refreshSchema, logoutSchema,
  forgotPasswordSchema, resetPasswordSchema,
  // Son absence ici faisait échouer /auth/verify-email en 500 : validate(undefined).
  verifyEmailSchema,
  mfaVerifySchema,
};
