'use strict';

const Joi = require('joi');

const envoyerMessageSupportSchema = Joi.object({
  // Une seule ligne : le sujet devient l'objet de l'email, et un saut de ligne
  // dans un en-tête permettrait d'en injecter d'autres.
  sujet: Joi.string().trim().min(3).max(150).pattern(/^[^\r\n]+$/).required(),
  message: Joi.string().trim().min(10).max(5000).required(),
  // Contexte technique facultatif, joint au message pour qualifier la demande
  // (quelle application, quelle version).
  contexte: Joi.object({
    plateforme: Joi.string().trim().max(30).optional().allow(''),
    version: Joi.string().trim().max(40).optional().allow(''),
  }).optional(),
});

module.exports = { envoyerMessageSupportSchema };
