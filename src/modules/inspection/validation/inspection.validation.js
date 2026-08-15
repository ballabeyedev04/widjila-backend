'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

const creerInspectionSchema = Joi.object({
  chantierId: uuid.required(),
  inspecteurId: uuid.optional().allow(null),
  type: Joi.string().valid('inspection', 'opr', 'visite_contradictoire').optional(),
  date_visite: Joi.date().iso().optional().allow('', null),
  // Checklist personnalisée (libellés de contrôle)
  checklist: Joi.array().items(
    Joi.object({
      libelle: Joi.string().trim().min(1).max(255).required(),
      coche: Joi.boolean().optional(),
      commentaire: Joi.string().trim().max(2000).optional().allow('', null),
    })
  ).optional(),
  // Modèle de checklist réutilisable (module 6)
  modeleId: uuid.optional().allow(null),
});

const modifierInspectionSchema = Joi.object({
  inspecteurId: uuid.optional().allow(null),
  type: Joi.string().valid('inspection', 'opr', 'visite_contradictoire').optional(),
  date_visite: Joi.date().iso().optional().allow('', null),
  statut: Joi.string().valid('planifiee', 'en_cours', 'terminee', 'signee').optional(),
  compte_rendu: Joi.string().trim().max(10000).optional().allow('', null),
});

const cocherChecklistSchema = Joi.object({
  coche: Joi.boolean().required(),
  commentaire: Joi.string().trim().max(2000).optional().allow('', null),
});

// Modèles de checklist (module 6)
const creerModeleSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  items: Joi.array().items(
    Joi.alternatives().try(
      Joi.string().trim().min(1).max(255),
      Joi.object({
        libelle: Joi.string().trim().min(1).max(255).required(),
        categorie: Joi.string().trim().max(100).optional().allow('', null),
      })
    )
  ).max(500).optional(),
});

const modifierModeleSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).optional(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  items: Joi.array().items(
    Joi.alternatives().try(
      Joi.string().trim().min(1).max(255),
      Joi.object({
        libelle: Joi.string().trim().min(1).max(255).required(),
        categorie: Joi.string().trim().max(100).optional().allow('', null),
      })
    )
  ).max(500).optional(),
});

// Convocations (module 6)
const convierSchema = Joi.object({
  utilisateurId: uuid.required(),
});

const repondreConvocationSchema = Joi.object({
  statut: Joi.string().valid('accepte', 'decline', 'present', 'absent').required(),
});

const appliquerModeleSchema = Joi.object({
  modeleId: uuid.required(),
});

module.exports = {
  creerInspectionSchema,
  modifierInspectionSchema,
  cocherChecklistSchema,
  creerModeleSchema,
  modifierModeleSchema,
  convierSchema,
  repondreConvocationSchema,
  appliquerModeleSchema,
};
