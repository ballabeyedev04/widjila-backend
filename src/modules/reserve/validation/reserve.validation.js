'use strict';

const Joi = require('joi');

/**
 * Position d'une réserve sur un plan — en POURCENTAGES de l'image (0-100).
 *
 * ## Pourquoi des bornes
 *
 * `x` et `y` n'en avaient aucune. Les deux clients bornent pourtant déjà leur
 * saisie — le mobile dans `plan_interactif.dart`, le web dans
 * `PlanCanvas.jsx` — mais une garde qui ne vit que chez le client ne garde
 * rien : il suffit d'un appel direct, d'une version plus ancienne de
 * l'application ou d'une future intégration pour écrire `x = 1450`.
 *
 * Une réserve hors bornes est dessinée hors du plan : invisible, ou plaquée
 * contre un bord au mauvais endroit. Personne ne la retrouve, et rien ne
 * signale l'anomalie.
 *
 * ## Pourquoi 0-100 et non 0-1
 *
 * C'est l'échelle réellement utilisée par les deux clients et par les données
 * déjà en base. Passer à 0-1 demanderait de convertir l'existant, sans rien
 * apporter : ce qui compte est que la valeur soit RELATIVE à l'image, ce
 * qu'un pourcentage est tout autant qu'une fraction.
 */
const POSITION_PLAN = Joi.object({
  x: Joi.number().min(0).max(100).required(),
  y: Joi.number().min(0).max(100).required(),
  // Le zoom au moment de la pose, conservé à titre indicatif. Un zoom nul ou
  // négatif n'a pas de sens ; un zoom démesuré trahit une erreur de calcul.
  zoom: Joi.number().greater(0).max(100).optional().default(1),
  /**
   * PAGE du document (cahier technique § 6 et § 18).
   *
   * Sans elle, les réserves d'un PDF multi-page se dessinaient toutes sur la
   * page affichée. Défaut 1 : le cas d'un plan d'une seule page, et celui de
   * tous les clients qui ne l'envoient pas encore.
   *
   * Plafond à 2000 : au-delà, ce n'est plus un plan de chantier, et une valeur
   * démesurée trahit une erreur de calcul côté client.
   */
  page: Joi.number().integer().min(1).max(2000).optional().default(1),
}).optional();

const { uuid, SEVERITE_PRIORITE, STATUT_RESERVE } = require('../../../validations/common.js');

/**
 * Forme À PLAT de la position : `positionX` / `positionY` à la racine du
 * corps, en plus de l'objet `position`.
 *
 * ── Pourquoi les deux ─────────────────────────────────────────────────────
 *
 * `position: { x, y }` est la forme historique, envoyée par le web et par le
 * mobile déjà en production ; elle ne bouge pas. Mais le point posé sur un
 * plan est désormais LA donnée de localisation d'une réserve, et toute
 * intégration qui la produit — un import, un outil tiers, un script — la
 * décrit naturellement à côté de `planId`, pas dans un sous-objet.
 *
 * Refuser cette forme obligeait à découvrir la bonne à l'usage, sur un 422 qui
 * ne dit pas laquelle. Les deux sont donc acceptées, et l'objet `position`
 * l'emporte quand les deux sont envoyées : c'est la forme la plus explicite,
 * et celle que les clients existants produisent.
 *
 * Les deux coordonnées vont ENSEMBLE. Une seule décrirait un point qui
 * n'existe pas — la refuser vaut mieux que d'inventer l'autre.
 */
const COORDONNEE_PLAN = Joi.number().min(0).max(100);

const APLATIR_POSITION = (valeur, helpers) => {
  const { positionX, positionY, positionZoom, positionPage, ...reste } = valeur;
  if (positionX === undefined && positionY === undefined) return reste;
  if (positionX === undefined || positionY === undefined) {
    // `helpers.message` et non `helpers.error` : le second garde le message
    // dans le contexte de l'erreur, sans jamais l'afficher — l'utilisateur
    // recevait « failed custom validation because » et rien d'autre.
    return helpers.message({
      custom: 'positionX et positionY vont ensemble : fournir les deux, ou aucun.',
    });
  }
  // `position` explicite : elle fait foi, la forme à plat est ignorée.
  if (reste.position) return reste;
  return {
    ...reste,
    position: {
      x: positionX,
      y: positionY,
      zoom: positionZoom ?? 1,
      // Page du document (cahier technique § 6, § 18) — 1 par défaut, comme
      // pour la forme objet.
      page: positionPage ?? 1,
    },
  };
};



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
  /**
   * Phase du chantier — OBLIGATOIRE.
   *
   * La règle est portée ICI et pas seulement par les formulaires : une requête
   * directe à l'API ne doit pas pouvoir créer une réserve sans phase. Le
   * message est explicite parce qu'il remonte tel quel à l'écran.
   */
  phaseId: uuid.required().messages({
    'any.required': 'Veuillez sélectionner une phase.',
    'string.empty': 'Veuillez sélectionner une phase.',
  }),
  titre: Joi.string().trim().min(2).max(200).required(),
  description: Joi.string().trim().max(5000).optional().allow('', null),
  severite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  priorite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  // Corps d'état (métier) — référence au catalogue administrable `corps_etat`.
  // `categorie` juste en dessous reste acceptée : un client mobile non mis à
  // jour continue de fonctionner, et l'export Excel s'appuie dessus.
  corpsEtatId: uuid.optional().allow(null),
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  entrepriseId: uuid.optional().allow(null),
  partenaireId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  // Position sur le plan (x, y) — enregistrée dans reserve_positions
  position: POSITION_PLAN,
  // Même position, forme à plat — voir APLATIR_POSITION.
  positionX: COORDONNEE_PLAN.optional(),
  positionY: COORDONNEE_PLAN.optional(),
  positionZoom: Joi.number().greater(0).max(100).optional(),
  positionPage: Joi.number().integer().min(1).max(2000).optional(),
}).custom(APLATIR_POSITION);

/**
 * Créer une réserve DEPUIS UN PLAN — cahier technique § 11 et § 12.
 *
 * Le même schéma que la création ordinaire, à deux champs près :
 *
 *  - `chantierId` n'est plus exigé : il est DÉDUIT du plan par le contrôleur.
 *    Le demander reviendrait à faire porter par le client une information
 *    qu'il n'a pas forcément sous la main, et à ouvrir la porte à une
 *    contradiction entre les deux.
 *  - `planId` n'est plus accepté : il est dans l'URL. L'accepter aussi dans le
 *    corps permettrait de poser la réserve sur un AUTRE plan que celui appelé,
 *    ce qui rendrait l'URL mensongère.
 */
const creerReserveSurPlanSchema = creerReserveSchema.fork(
  ['chantierId'],
  (champ) => champ.optional(),
).fork(['planId'], (champ) => champ.forbidden());

const modifierReserveSchema = Joi.object({
  titre: Joi.string().trim().min(2).max(200).optional(),
  description: Joi.string().trim().max(5000).optional().allow('', null),
  severite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  priorite: Joi.string().valid(...SEVERITE_PRIORITE).optional(),
  // Corps d'état (métier) — référence au catalogue administrable `corps_etat`.
  // `categorie` juste en dessous reste acceptée : un client mobile non mis à
  // jour continue de fonctionner, et l'export Excel s'appuie dessus.
  corpsEtatId: uuid.optional().allow(null),
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  batimentId: uuid.optional().allow(null),
  etageId: uuid.optional().allow(null),
  zoneId: uuid.optional().allow(null),
  planId: uuid.optional().allow(null),
  lotId: uuid.optional().allow(null),
  // Corriger une phase mal choisie reste possible ; la VIDER ne l'est pas
  // (`allow(null)` volontairement absent) : une réserve déjà rattachée ne doit
  // jamais retomber sans phase, c'est ce qui garantit l'historique.
  phaseId: uuid.optional(),
  entrepriseId: uuid.optional().allow(null),
  partenaireId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  position: POSITION_PLAN,
  positionX: COORDONNEE_PLAN.optional(),
  positionY: COORDONNEE_PLAN.optional(),
  positionZoom: Joi.number().greater(0).max(100).optional(),
  positionPage: Joi.number().integer().min(1).max(2000).optional(),
  // Valeurs que le client avait SOUS LES YEUX avant sa modification — le
  // service s'en sert pour détecter qu'un autre a modifié le même champ
  // entre-temps (A2-13, `ReserveService._conflitsModification`). Sans cette
  // déclaration, `stripUnknown` la retirait : le mobile l'envoyait, le serveur
  // ne la voyait jamais, et la seconde modification écrasait la première.
  valeursInitiales: Joi.object().pattern(Joi.string().max(50), Joi.any()).max(20).optional(),
}).custom(APLATIR_POSITION);

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
  // Toutes les réserves de la série partagent la même phase : elle est requise
  // ici comme à la création unitaire.
  phaseId: uuid.required().messages({
    'any.required': 'Veuillez sélectionner une phase.',
  }),
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
  // Corps d'état (métier) — référence au catalogue administrable `corps_etat`.
  // `categorie` juste en dessous reste acceptée : un client mobile non mis à
  // jour continue de fonctionner, et l'export Excel s'appuie dessus.
  corpsEtatId: uuid.optional().allow(null),
  categorie: Joi.string().valid('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre').optional(),
  batimentId: uuid.optional().allow(null),
  etageId: uuid.optional().allow(null),
  zoneId: uuid.optional().allow(null),
  planId: uuid.optional().allow(null),
  lotId: uuid.optional().allow(null),
  entrepriseId: uuid.optional().allow(null),
  partenaireId: uuid.optional().allow(null),
  assigneA: uuid.optional().allow(null),
  date_limite: Joi.date().iso().optional().allow('', null),
  position: POSITION_PLAN,
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

/**
 * Affecter une réserve : à un COMPTE, à une ENTREPRISE UTILISATRICE, ou à une
 * entreprise de l'ANNUAIRE du chantier.
 *
 * Les trois destinataires ne sont pas interchangeables :
 *   - `utilisateurId` → un compte de l'organisation ;
 *   - `entrepriseId`  → une organisation de la plateforme (elle a son espace) ;
 *   - `partenaireId`  → une fiche de l'annuaire du chantier, sans compte.
 *
 * `partenaireId` MANQUAIT, et c'est ce qui produisait « Entreprise
 * introuvable » : le mobile listait l'annuaire puis envoyait l'identifiant
 * retenu dans `entrepriseId`, où le serveur cherchait une organisation.
 */
const affecterReserveSchema = Joi.object({
  utilisateurId: uuid.optional().allow(null),
  entrepriseId: uuid.optional().allow(null),
  partenaireId: uuid.optional().allow(null),
  date_affectation: Joi.date().iso().optional().allow('', null),
}).custom((v, helpers) => {
  if (!v.utilisateurId && !v.entrepriseId && !v.partenaireId) {
    // `helpers.message` et non `helpers.error` : le second garde le texte dans
    // le contexte de l'erreur sans jamais l'afficher.
    return helpers.message({
      custom: 'Préciser un utilisateur, une entreprise ou un intervenant.',
    });
  }
  return v;
});

module.exports = {
  creerReserveSchema,
  creerReserveSurPlanSchema,
  modifierReserveSchema,
  changerStatutReserveSchema,
  ajouterCommentaireSchema,
  creerSerieReservesSchema,
  signerReserveSchema,
  affecterReserveSchema,
};
