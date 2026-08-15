'use strict';

const Joi = require('joi');

const creerPaymentIntentSchema = Joi.object({
  planId: Joi.string().valid('starter', 'pro', 'business').required(),
});

module.exports = {
  creerPaymentIntentSchema,
};