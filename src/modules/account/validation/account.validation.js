'use strict';

const Joi = require('joi');
const { nom, prenom, telephone, motDePasse } = require('../../../validations/common.js');

const updateProfilSchema = Joi.object({
  nom: nom.optional(),
  prenom: prenom.optional(),
  telephone: telephone.optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  // Langues supportées par l'interface — miroir de LANGUES côté admin
  // (admin/src/utils/constants.js) et des fichiers admin/src/i18n/locales/.
  langue: Joi.string().valid('fr', 'en', 'de', 'es').optional(),
});

const changePasswordSchema = Joi.object({
  ancien_mot_de_passe: Joi.string().required(),
  nouveau_mot_de_passe: motDePasse.required(),
});

const saveDeviceTokenSchema = Joi.object({
  token: Joi.string().trim().required(),
  platform: Joi.string().valid('android', 'ios', 'web').optional(),
});

// MFA — code TOTP à 6 chiffres ; le secret n'est requis qu'à l'activation
const activerMfaSchema = Joi.object({
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Le code de vérification doit contenir 6 chiffres',
  }),
  secret: Joi.string().trim().required(),
});

const desactiverMfaSchema = Joi.object({
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Le code de vérification doit contenir 6 chiffres',
  }),
});

module.exports = {
  updateProfilSchema, changePasswordSchema, saveDeviceTokenSchema,
  activerMfaSchema, desactiverMfaSchema,
};
