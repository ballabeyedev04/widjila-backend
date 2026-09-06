'use strict';

const Joi = require('joi');
const { uuid, STATUT_CHANTIER } = require('../../../validations/common.js');
const { TYPE_NIVEAU } = require('../../../config/enums.js');

const creerChantierSchema = Joi.object({
  // Organisation destinataire. Renseignée UNIQUEMENT par le super-admin
  // plateforme, qui n'appartient à aucune organisation et doit donc désigner
  // le client pour lequel il crée le chantier. Pour les autres rôles, le
  // contrôleur refuse toute valeur différente de leur propre organisation.
  organisationId: uuid.optional().allow(null),
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

// Refus d'une demande de chantier.
//
// Le motif est OBLIGATOIRE et d'une longueur minimale : c'est la seule
// explication que reçoit le demandeur, et « non » ne lui dit pas quoi
// corriger. Le plafond protège le gabarit du courriel.
const rejeterChantierSchema = Joi.object({
  motif: Joi.string().trim().min(10).max(2000).required().messages({
    'string.min': 'Précisez le motif du refus (10 caractères au minimum) — c’est la seule indication reçue par le demandeur.',
    'any.required': 'Le motif du refus est obligatoire.',
  }),
});

// `min(1)` et non `min(2)` : sur un chantier, les bâtiments s'appellent « A »,
// « B », « C » — c'est même ainsi que le client les décrit. Le plancher à deux
// caractères refusait ces noms-là d'un 422, sur l'écran de dépôt où le
// bâtiment est la toute première chose à créer. Les niveaux et les zones
// acceptaient déjà un caractère : ce plancher était une divergence, pas une
// règle.
const creerBatimentSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).required(),
  code: Joi.string().trim().max(50).optional().allow('', null),
});

const creerEtageSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).required(),
  niveau: Joi.number().integer().optional(),
  // Nature du niveau — range l'étage sous « SOUS-SOLS », « ÉTAGES » ou
  // « TOITURE ». Facultative : le modèle applique 'etage', et les écrans
  // existants ne l'envoient pas.
  typeNiveau: Joi.string().valid(...TYPE_NIVEAU).optional(),
  // Code choisi dans le référentiel (`/referentiels/codes-niveau`). Non
  // contraint à la liste ici : le référentiel est extensible en cours de
  // saisie, et revalider contre un instantané rejetterait un code créé la
  // seconde d'avant. Le format, lui, est vérifié.
  codeNiveau: Joi.string().trim().max(20).pattern(/^[A-Za-z0-9+\-]+$/).optional().allow('', null),
  description: Joi.string().trim().max(2000).optional().allow('', null),
});

const creerZoneSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).required(),
  type: Joi.string().valid('logement', 'piece', 'zone', 'local').optional(),
});

/**
 * Modification de la structure — `.min(1)` : un PUT sans aucun champ ne
 * décrit aucune intention et produirait un `update({})` silencieux, qui
 * répondrait « modifié » sans rien changer.
 */
const modifierBatimentSchema = Joi.object({
  // Même plancher qu'à la création : sans quoi un bâtiment « A » se créerait
  // mais ne se renommerait plus.
  nom: Joi.string().trim().min(1).max(100).optional(),
  code: Joi.string().trim().max(50).optional().allow('', null),
}).min(1);

const modifierEtageSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).optional(),
  niveau: Joi.number().integer().optional(),
}).min(1);

const modifierZoneSchema = Joi.object({
  nom: Joi.string().trim().min(1).max(100).optional(),
  type: Joi.string().valid('logement', 'piece', 'zone', 'local').optional(),
}).min(1);

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
  rejeterChantierSchema,
  creerBatimentSchema,
  creerEtageSchema,
  creerZoneSchema,
  modifierBatimentSchema,
  modifierEtageSchema,
  modifierZoneSchema,
  creerLotSchema,
  dupliquerChantierSchema,
  creerPhaseSchema,
  modifierPhaseSchema,
};
