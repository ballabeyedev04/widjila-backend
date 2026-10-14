'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const uploadDocumentSchema = Joi.object({
  chantierId: uuid.required(),
  // Le type n'est plus énuméré ici : il vit dans un référentiel
  // administrable, et une liste figée empêcherait d'en ajouter. Seule la
  // FORME est contrôlée ; l'existence l'est par le middleware
  // `verifierTypeReferentiel`, posé sur la route.
  type: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).max(50).optional(),

});

// `donnees` : tracé de la signature (image en data URL, ou points du tracé).
// Il était `Joi.any()` — n'importe quel JSON jusqu'à la limite du corps
// (512 ko), stocké tel quel (audit sécurité SC-06). Borné ici à ce qu'un tracé
// peut raisonnablement peser.
const signerDocumentSchema = Joi.object({
  donnees: Joi.alternatives().try(
    Joi.string().max(300000),
    Joi.object().max(50),
    Joi.array().max(5000),
  ).optional().allow(null),
});

module.exports = { uploadDocumentSchema, signerDocumentSchema };
