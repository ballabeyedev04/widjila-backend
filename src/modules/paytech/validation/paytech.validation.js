'use strict';

const Joi = require('joi');

// CODE de formule du catalogue (essentiel, pro, entreprise…) — son existence
// et son prix sont vérifiés en base par le contrôleur. L'ancienne liste figée
// (starter/pro/business) ne correspondait plus au catalogue : seule « pro »
// pouvait être achetée. Longueur bornée pour que `ref_command` (64 car. max,
// seule donnée signée de l'IPN) contienne toujours le code en entier.
const createPaymentSchema = Joi.object({
  planId: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]{1,22}$/).required(),
});

module.exports = {
  createPaymentSchema,
};