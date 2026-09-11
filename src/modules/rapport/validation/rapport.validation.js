'use strict';

const Joi = require('joi');
const { STATUT_RESERVE } = require('../../../config/enums.js');
const { uuid } = require('../../../validations/common.js');
const R = require('../service/rapportReferentiel.js');

/* ══════════════════════════════════════════════════════════════════════════
   Ancien point d'entrée — POST /chantiers/:id/rapports/generer
   ══════════════════════════════════════════════════════════════════════════ */

const genererRapportSchema = Joi.object({
  chantierId: uuid.required(),
  type: Joi.string().valid('reserves', 'entreprise', 'batiment', 'qualite', 'visite', 'opr').optional(),
  // Aligné sur l'ENUM complet de `reserves.statut`.
  statut: Joi.string().valid(...STATUT_RESERVE).optional(),
  entrepriseId: uuid.optional().allow(null),
  // Entreprise RÉELLE (annuaire des partenaires) — distincte de
  // `entrepriseId`, qui vise une organisation de la plateforme.
  partenaireId: uuid.optional().allow(null),
  batimentId: uuid.optional().allow(null),
  phaseId: uuid.optional().allow(null),
  corpsEtatId: uuid.optional().allow(null),
  inspectionId: uuid.optional().allow(null),
});

/* ══════════════════════════════════════════════════════════════════════════
   Module Rapports — § 9 et § 10 du cahier des charges
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Valeur d'un filtre : un identifiant, un libellé (« R+3 », § 10), une date,
 * ou une liste de ces valeurs (« Toutes ou sélection », § 4).
 *
 * Les CLÉS des filtres ne sont pas figées ici : le § 10 les écrit en anglais
 * (`building_id`, `levels`, `statuses`), l'application en français
 * (`batiments`, `etages`, `statuts`), et `rapportDonnees.service.js` sait lire
 * les deux. Une liste fermée ferait disparaître l'une des deux formes sous
 * l'effet de `stripUnknown` — sans la moindre erreur, donc sans que personne
 * ne comprenne pourquoi le filtre n'agit pas.
 */
const valeurFiltre = Joi.alternatives().try(
  Joi.string().trim().max(120).allow(''),
  Joi.array().items(Joi.string().trim().max(120)).max(300),
  Joi.valid(null),
);

const filtresSchema = Joi.object().pattern(Joi.string().max(40), valeurFiltre).max(40);

/** Les cinq sections du § 10. */
const sectionsSchema = Joi.object(
  Object.fromEntries(R.SECTIONS.map((cle) => [cle, Joi.boolean()])),
);

/** Formats du § 4 : PDF, Excel, ou les deux. « EXCEL » est accepté pour XLSX. */
const unFormat = Joi.string().trim().uppercase().valid('PDF', 'XLSX', 'EXCEL');
const formatsSchema = Joi.alternatives().try(
  Joi.array().items(unFormat).min(1).max(3),
  unFormat,
);

/**
 * POST /reports — la configuration du § 10.
 *
 * Les deux vocabulaires sont acceptés : celui du cahier des charges
 * (`project_id`, `name`, `template_id`, `filters`, `format`) et celui de
 * l'application (`chantierId`, `nom`, `modele`, `filtres`, `formats`).
 */
const creerRapportSchema = Joi.object({
  chantierId: uuid,
  project_id: uuid,
  nom: Joi.string().trim().max(200).allow(''),
  name: Joi.string().trim().max(200).allow(''),
  modele: Joi.string().trim().max(30),
  template_id: Joi.string().trim().max(30),
  filtres: filtresSchema,
  filters: filtresSchema,
  sections: sectionsSchema,
  formats: formatsSchema,
  format: formatsSchema,
})
  .or('chantierId', 'project_id')
  .or('modele', 'template_id');

/** PATCH /reports/:id — revenir sur la configuration (§ 20). */
const modifierRapportSchema = Joi.object({
  nom: Joi.string().trim().max(200).allow(''),
  name: Joi.string().trim().max(200).allow(''),
  modele: Joi.string().trim().max(30),
  template_id: Joi.string().trim().max(30),
  filtres: filtresSchema,
  filters: filtresSchema,
  sections: sectionsSchema,
  formats: formatsSchema,
  format: formatsSchema,
}).min(1);

/** GET /reports — liste, filtrable par projet, état et modèle. */
const listerRapportsQuery = Joi.object({
  project_id: uuid,
  chantierId: uuid,
  statut: Joi.string().valid(...R.CODES_ETAT),
  modele: Joi.string().trim().max(30),
  lot: uuid,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

/** GET /reports/:id/download — le PDF par défaut, l'Excel sur demande. */
const telechargerQuery = Joi.object({
  format: Joi.string().trim().lowercase().valid('pdf', 'xlsx').default('pdf'),
});

/** GET /reports/:id/preview — le PDF filigrané, ou son résumé chiffré. */
const previsualiserQuery = Joi.object({
  mode: Joi.string().valid('pdf', 'resume').default('pdf'),
});

/**
 * Envoi par e-mail (§ 13).
 *
 * `exclure` retire des destinataires proposés ; `destinataires` et `copies`
 * choisissent PARMI les candidats calculés par le serveur. Aucun des deux ne
 * permet d'ajouter une adresse étrangère au chantier : le service la refuse
 * en la nommant (§ 21, validation des destinataires).
 */
const envoyerRapportSchema = Joi.object({
  exclure: Joi.array().items(Joi.string().trim().email()).max(50).optional(),
  destinataires: Joi.array().items(Joi.string().trim().email()).max(50).optional(),
  copies: Joi.array().items(Joi.string().trim().email()).max(50).optional(),
  // Une ligne : un retour chariot dans un objet de courriel n'a pas d'usage
  // légitime, et c'est le vecteur classique d'injection d'en-têtes.
  objet: Joi.string().trim().max(250).pattern(/^[^\r\n]*$/).allow('').optional()
    .messages({ 'string.pattern.base': 'L’objet doit tenir sur une seule ligne' }),
  message: Joi.string().trim().max(5000).allow('').optional(),
  mode: Joi.string().valid('piece_jointe', 'lien').optional(),
});

/** POST /reports/:id/share — le lien sécurisé du § 14. */
const partagerRapportSchema = Joi.object({
  expireDansJours: Joi.number().integer().min(1).max(365).allow(null),
  expires_in_days: Joi.number().integer().min(1).max(365).allow(null),
  authentificationRequise: Joi.boolean(),
  require_auth: Joi.boolean(),
});

module.exports = {
  genererRapportSchema,
  envoyerRapportSchema,
  creerRapportSchema,
  modifierRapportSchema,
  listerRapportsQuery,
  telechargerQuery,
  previsualiserQuery,
  partagerRapportSchema,
};
