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

module.exports = { genererRapportSchema };
