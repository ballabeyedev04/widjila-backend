'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const notifierUtilisateurSchema = Joi.object({
  utilisateurId: uuid.required(),
  type: Joi.string().trim().max(50).required(),
  titre: Joi.string().trim().max(200).required(),
  message: Joi.string().trim().max(2000).optional().allow('', null),
  donnees: Joi.object().optional(),
});

const marquerLuesSchema = Joi.object({
  ids: Joi.array().items(uuid).optional(),
});

const broadcastSchema = Joi.object({
  type: Joi.string().trim().max(50).optional(),
  titre: Joi.string().trim().min(1).max(200).required(),
  message: Joi.string().trim().max(3000).optional().allow('', null),
  donnees: Joi.any().optional(),
});

// Un jeton FCM fait ~160 caractères mais Google n'en garantit pas la longueur.
// Les bornes protègent la colonne et évitent qu'un client n'envoie un pavé.
const deviceTokenSchema = Joi.object({
  token: Joi.string().trim().min(20).max(512).required(),
  platform: Joi.string().valid('android', 'ios', 'web').optional(),
});

const supprimerDeviceTokenSchema = Joi.object({
  token: Joi.string().trim().min(20).max(512).required(),
});

module.exports = {
  notifierUtilisateurSchema,
  marquerLuesSchema,
  broadcastSchema,
  deviceTokenSchema,
  supprimerDeviceTokenSchema,
};
