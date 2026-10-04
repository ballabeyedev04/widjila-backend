'use strict';

const Joi = require('joi');

/**
 * Ce que le client a le droit d'écrire, et ce qu'il n'a PAS le droit
 * d'écrire.
 *
 * La demande décrit un BESOIN : volumes souhaités, durée envisagée, contexte.
 * Aucun montant n'y figure — ni HT, ni TTC, ni remise. Le chiffrage appartient
 * au super-admin, et le schéma de demande ne comporte donc aucun champ par
 * lequel un prix pourrait entrer : c'est la garde la plus sûre, puisqu'il n'y
 * a rien à oublier de vérifier.
 */
const demanderDevisSchema = Joi.object({
  // Formule « sur devis » visée — identifiant ou code. Facultative : à
  // défaut, le service retient celle du catalogue.
  planId: Joi.string().trim().pattern(/^[a-zA-Z0-9-]{1,36}$/).optional(),

  societe: Joi.string().trim().max(200).allow('', null),
  siren: Joi.string().trim().max(32).allow('', null),
  contact: Joi.string().trim().max(150).allow('', null),
  email: Joi.string().trim().email().max(180).allow('', null),
  telephone: Joi.string().trim().max(40).allow('', null),

  // Bornes larges mais réelles : elles écartent la saisie accidentelle
  // (« 999999 utilisateurs ») sans contraindre un groupe de BTP.
  nbUtilisateurs: Joi.number().integer().min(1).max(10000).allow(null),
  nbChantiers: Joi.number().integer().min(1).max(10000).allow(null),
  dureeSouhaitee: Joi.number().integer().min(1).max(120).allow(null),

  besoins: Joi.string().trim().max(4000).allow('', null),
});

/** Refus motivé — le motif nous sert à reformuler, il reste facultatif. */
const refuserDevisSchema = Joi.object({
  motif: Joi.string().trim().max(2000).allow('', null),
});

/**
 * Chiffrage par le super-admin.
 *
 * `montantHt` et `dureeMois` sont obligatoires : un devis sans montant ni
 * durée ne peut être ni accepté ni payé. La TVA et le TTC ne se saisissent
 * PAS — ils sont calculés par le service à partir du HT et du taux, pour
 * qu'aucune faute de frappe ne se glisse dans ce qui sera débité.
 *
 * `limite*` à `null` signifie ILLIMITÉ, et c'est volontairement distinct de
 * l'absence du champ, qui laisse la valeur en place.
 */
const preparerDevisSchema = Joi.object({
  montantHt: Joi.number().min(0).max(10000000).required(),
  tauxTva: Joi.number().min(0).max(100).optional(),
  devise: Joi.string().trim().uppercase().length(3).optional(),
  dureeMois: Joi.number().integer().min(1).max(120).required(),
  limiteUtilisateurs: Joi.number().integer().min(1).max(100000).allow(null).optional(),
  limiteChantiers: Joi.number().integer().min(1).max(100000).allow(null).optional(),
  options: Joi.array().items(Joi.string().trim().max(50)).allow(null).optional(),
  conditions: Joi.string().trim().max(8000).allow('', null).optional(),
  expireLe: Joi.date().iso().greater('now').optional(),
});

/** Filtres de la liste d'administration. */
const listerDevisSchema = Joi.object({
  statut: Joi.string().valid('brouillon', 'envoye', 'accepte', 'refuse', 'expire').optional(),
  organisationId: Joi.string().uuid().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

module.exports = {
  demanderDevisSchema,
  refuserDevisSchema,
  preparerDevisSchema,
  listerDevisSchema,
};
