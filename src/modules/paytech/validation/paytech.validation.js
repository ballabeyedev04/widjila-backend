'use strict';

const Joi = require('joi');

const createPaymentSchema = Joi.object({
  planId: Joi.string().valid('starter', 'pro', 'business').required(),
});

module.exports = {
  createPaymentSchema,
};