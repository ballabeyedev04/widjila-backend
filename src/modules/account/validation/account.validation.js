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
  // Refresh token de l'appareil qui fait la demande — FACULTATIF.
  //
  // Changer son mot de passe révoque les autres sessions ; sans ce champ, le
  // serveur n'a aucun moyen de savoir laquelle est celle de l'appelant (le
  // token d'accès ne porte pas d'identifiant de session) et devrait donc
  // toutes les révoquer, y compris celle de l'utilisateur en train d'agir.
  //
  // Il transite dans le corps, jamais dans l'URL, et morgan ne journalise pas
  // les corps de requête (voir app.js) : pas d'exposition nouvelle par
  // rapport à l'en-tête Authorization du même appel.
  refresh_token: Joi.string().trim().optional().allow('', null),
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
