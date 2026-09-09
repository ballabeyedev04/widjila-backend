'use strict';

const Joi = require('joi');
const { STATUT_RESERVE } = require('../../../config/enums.js');
const { uuid } = require('../../../validations/common.js');

const genererRapportSchema = Joi.object({
  chantierId: uuid.required(),
  type: Joi.string().valid('reserves', 'entreprise', 'batiment', 'qualite', 'visite', 'opr').optional(),
  // Aligné sur l'ENUM complet de `reserves.statut` : `prise_en_charge` et
  // `en_retard` en étaient absents, ce qui rendait impossible un rapport des
  // réserves en retard — pourtant le plus demandé.
  statut: Joi.string().valid(...STATUT_RESERVE).optional(),
  entrepriseId: uuid.optional().allow(null),
  // Entreprise RÉELLE (annuaire des partenaires) — distincte de
  // `entrepriseId`, qui vise une organisation de la plateforme.
  partenaireId: uuid.optional().allow(null),
  batimentId: uuid.optional().allow(null),
  // Nouveaux axes de filtrage du rapport, alignés sur ceux des réserves.
  phaseId: uuid.optional().allow(null),
  corpsEtatId: uuid.optional().allow(null),
  /**
   * Inspection ciblée — sert UNIQUEMENT à renseigner la colonne « Présence »
   * des participants, à partir des convocations pointées ce jour-là. Absente,
   * la colonne reste vide plutôt que d'affirmer une présence non constatée.
   */
  inspectionId: uuid.optional().allow(null),
});

/**
 * Confirmation d'envoi.
 *
 * `exclure` ne porte QUE des retraits : la liste des destinataires est
 * recalculée côté serveur, l'appelant peut en enlever, jamais en ajouter.
 * Accepter des adresses libres ferait de cette route un relais de courriel
 * ouvert, capable d'expédier un document interne n'importe où.
 */
const envoyerRapportSchema = Joi.object({
  exclure: Joi.array().items(Joi.string().trim().email()).max(50).optional(),
});

module.exports = { genererRapportSchema, envoyerRapportSchema };
