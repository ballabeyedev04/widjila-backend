'use strict';

const Joi = require('joi');
const { uuid, SEVERITE_PRIORITE, STATUT_RESERVE } = require('../../../validations/common.js');

const creerReserveSchema = Joi.object({
  // Identifiant fourni par le CLIENT (mode hors ligne du mobile).
  //
  // Une reserve creee au sous-sol, sans reseau, doit pouvoir etre referencee
  // immediatement (photo attachee, changement de statut) avant meme d'avoir
  // ete envoyee. Laisser le serveur generer l'id imposerait de remapper apres
  // coup toutes les actions en attente qui la referencent.
  //
  // Absent = comportement historique (le serveur genere l'UUID) : l'admin web
  // n'a pas besoin de ce mecanisme.
  id: uuid.optional(),
  chantierId: uuid.required(),
  batimentId: uuid.optional().allow(null),
  etageId: uuid.optional().allow(null),
  zoneId: uuid.optional().allow(null),
  planId: uuid.optional().allow(null),
  lotId: uuid.optional().allow(null),
  titre: Joi.string().trim().min(2).max(200).required(),
  description: Joi.string().trim().max(5000).optional().allow('', null),
  severite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  priorite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  entrepriseId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  // Position sur le plan (x, y) — enregistrée dans reserve_positions
  position: Joi.object({
    x: Joi.number().required(),
    y: Joi.number().required(),
    zoom: Joi.number().optional().default(1),
  }).optional(),
});

const modifierReserveSchema = Joi.object({
  titre: Joi.string().trim().min(2).max(200).optional(),
  description: Joi.string().trim().max(5000).optional().allow('', null),
  severite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  priorite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  batimentId: uuid.optional().allow(null),
  etageId: uuid.optional().allow(null),
  zoneId: uuid.optional().allow(null),
  planId: uuid.optional().allow(null),
  lotId: uuid.optional().allow(null),
  entrepriseId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  position: Joi.object({
    x: Joi.number().required(),
    y: Joi.number().required(),
    zoom: Joi.number().optional().default(1),
  }).optional(),
});

const changerStatutReserveSchema = Joi.object({
  statut: Joi.string().valid(...STATUT_RESERVE).required(),
  motif: Joi.string().trim().max(2000).optional().allow('', null),
});

const ajouterCommentaireSchema = Joi.object({
  message: Joi.string().trim().min(1).max(3000).required(),
});

// Série de réserves : soit une liste de titres, soit un titre + un nombre
const creerSerieReservesSchema = Joi.object({
  chantierId: uuid.required(),
  titres: Joi.array().items(Joi.string().trim().min(2).max(200)).min(1).max(100).optional(),
  titre: Joi.string().trim().min(2).max(200).optional(),
  nombre: Joi.number().integer().min(1).max(100).optional(),
  description: Joi.string().trim().max(5000).optional().allow('', null),
  severite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  priorite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  // Aligné sur creerReserveSchema : la colonne est un ENUM PostgreSQL. Une
  // valeur libre passait Joi puis échouait à l'INSERT — et depuis que la série
  // est transactionnelle, elle ferait échouer TOUTE la série, plus seulement
  // la première ligne.
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  batimentId: uuid.optional().allow(null),
  etageId: uuid.optional().allow(null),
  zoneId: uuid.optional().allow(null),
  planId: uuid.optional().allow(null),
  lotId: uuid.optional().allow(null),
  entrepriseId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  position: Joi.object({
    x: Joi.number().required(),
    y: Joi.number().required(),
    zoom: Joi.number().optional().default(1),
  }).optional(),
})
  .custom((v, helpers) => {
    const aTitres = Array.isArray(v.titres) && v.titres.length > 0;
    const aTitreNombre = v.titre && v.nombre;
    if (!aTitres && !aTitreNombre) {
      return helpers.error('any.custom', { message: 'Fournir "titres" (liste) ou "titre" + "nombre"' });
    }
    if (aTitres && (v.titre || v.nombre)) {
      return helpers.error('any.custom', { message: 'Choisir soit "titres", soit "titre" + "nombre"' });
    }
    return v;
  });

const signerReserveSchema = Joi.object({
  type: Joi.string().valid('signature', 'validation', 'refus').optional().default('signature'),
  donnees: Joi.any().optional(),
});

const affecterReserveSchema = Joi.object({
  utilisateurId: uuid.optional().allow(null),
  entrepriseId: uuid.optional().allow(null),
  date_affectation: Joi.date().iso().optional().allow('', null),
}).custom((v, helpers) => {
  if (!v.utilisateurId && !v.entrepriseId) {
    return helpers.error('any.custom', { message: 'Préciser un utilisateur ou une entreprise' });
  }
  return v;
});

module.exports = {
  creerReserveSchema,
  modifierReserveSchema,
  changerStatutReserveSchema,
  ajouterCommentaireSchema,
  creerSerieReservesSchema,
  signerReserveSchema,
  affecterReserveSchema,
};
