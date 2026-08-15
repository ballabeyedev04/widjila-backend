'use strict';

const Joi = require('joi');
const { uuid, STATUT_CHANTIER } = require('../../../validations/common.js');

const creerChantierSchema = Joi.object({
  code: Joi.string().trim().max(50).optional().allow('', null),
  nom: Joi.string().trim().min(2).max(200).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  adresse: Joi.string().trim().max(300).optional().allow('', null),
  latitude: Joi.number().min(-90).max(90).optional().allow(null),
  longitude: Joi.number().min(-180).max(180).optional().allow(null),
  date_debut: Joi.date().iso().optional().allow('', null),
  date_fin: Joi.date().iso().optional().allow('', null),
  responsableId: uuid.optional().allow(null),
  budget: Joi.number().positive().optional().allow(null),
  // Statut du chantier (module 3 / #42). Facultatif : le modèle retombe sur
  // 'en_preparation'. Permet de créer directement un chantier déjà démarré —
  // le formulaire d'admin propose le choix dès la création.
  statut: Joi.string().valid(...STATUT_CHANTIER).optional(),
});

const modifierChantierSchema = creerChantierSchema.fork(['nom'], (f) => f.optional());

const changerStatutSchema = Joi.object({
  statut: Joi.string().valid(...STATUT_CHANTIER).required(),
});

const creerBatimentSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(100).required(),
  code: Joi.string().trim().max(50).optional().allow('', null),
});

const creerEtageSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).required(),
  niveau: Joi.number().integer().optional(),
});

const creerZoneSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).required(),
  type: Joi.string().valid('logement', 'piece', 'zone', 'local').optional(),
});

const creerLotSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(100).required(),
  code: Joi.string().trim().max(50).optional().allow('', null),
  corps_d_etat: Joi.string().trim().max(100).optional().allow('', null),
});

// Duplication (module 3) — nom facultatif (défaut : "<nom> (copie)")
const dupliquerChantierSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(200).optional().allow('', null),
});

// Phases / planning (module 3)
const creerPhaseSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).optional(),
  date_debut: Joi.date().iso().optional().allow('', null),
  date_fin: Joi.date().iso().optional().allow('', null),
  statut: Joi.string().valid('planifiee', 'en_cours', 'terminee').optional(),
});

const modifierPhaseSchema = creerPhaseSchema.fork(['nom'], (f) => f.optional()).min(1);

module.exports = {
  creerChantierSchema,
  modifierChantierSchema,
  changerStatutSchema,
  creerBatimentSchema,
  creerEtageSchema,
  creerZoneSchema,
  creerLotSchema,
  dupliquerChantierSchema,
  creerPhaseSchema,
  modifierPhaseSchema,
};
