'use strict';

const Joi = require('joi');
const { uuid } = require('../../../validations/common.js');

/**
 * Référentiel des phases.
 *
 * Ni `chantierId`, ni `date_debut`, ni `date_fin`, ni `statut` ne sont
 * acceptés ici : ce sont les champs de la phase de PLANNING, servie par
 * `/chantiers/:id/phases`. Les laisser passer permettrait de fabriquer, par
 * la route du référentiel, une phase de planning rattachée à un chantier
 * arbitraire.
 */
const creerPhaseReferentielSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // Réservé au super-admin plateforme : le service ignore ce champ pour tout
  // autre rôle, qui crée forcément dans SA propre organisation.
  organisationId: uuid.optional().allow(null),
});

const modifierPhaseReferentielSchema = Joi.object({
  nom: Joi.string().trim().min(2).max(150).optional(),
  description: Joi.string().trim().max(2000).optional().allow('', null),
  ordre: Joi.number().integer().min(0).max(100000).optional(),
  actif: Joi.boolean().optional(),
  // `.min(1)` : un PUT vide produirait un `update({})` silencieux, qui
  // répondrait « modifiée » sans rien changer.
}).min(1);

const basculerActifPhaseSchema = Joi.object({
  actif: Joi.boolean().required(),
});

module.exports = {
  creerPhaseReferentielSchema,
  modifierPhaseReferentielSchema,
  basculerActifPhaseSchema,
};
