'use strict';

const Joi = require('joi');
const { uuid, couleurHex, urlHttp } = require('../../../validations/common.js');

const uploadPlanSchema = Joi.object({
  chantierId: uuid.required(),
  // Niveau décrit par le plan — au plus un des trois (voir plan.model.js).
  // Aucun des trois = plan global du chantier.
  batimentId: uuid.optional().allow(null, ''),
  etageId: uuid.optional().allow(null, ''),
  zoneId: uuid.optional().allow(null, ''),
  // Plan PARENT — le plan dont celui-ci est le détail (une pièce dans un
  // appartement, une façade dans un bâtiment).
  //
  // Prioritaire sur les trois précédents : un plan de détail hérite de la
  // place de son parent, et le rattachement envoyé à côté est ignoré (voir
  // plan.service.js#_resoudreRattachement). Deux places contradictoires pour
  // un même plan seraient impossibles à arbitrer plus tard.
  parentId: uuid.optional().allow(null, ''),
  nom: Joi.string().trim().min(2).max(200).required(),
  format: Joi.string().valid('pdf', 'dwg', 'ifc').optional(),
  /**
   * Discipline du plan — « Architecture », « Électricité », « Plomberie »…
   * (cahier technique § 4, champ « Type »).
   *
   * Libre, parce que le document dit « etc. » : une liste fermée obligerait à
   * livrer une nouvelle version du serveur pour accepter « Désenfumage ».
   * Borné à 80 caractères, comme la colonne.
   */
  type_plan: Joi.string().trim().max(80).optional().allow(null, ''),
  /**
   * Date DU PLAN, distincte de la date de dépôt (cahier technique § 4).
   *
   * Bornée au futur proche : un plan daté de 2040 est une faute de frappe, pas
   * une prévision. On tolère un an d'avance — les plans d'exécution d'un
   * chantier long peuvent être datés en amont.
   */
  date_plan: Joi.date().iso().max(new Date(Date.now() + 365 * 24 * 3600 * 1000))
    .optional().allow(null, ''),
});

/**
 * Déposer une nouvelle version d'un plan — cahier technique § 11.
 *
 * Ni `nom` ni rattachement : ils sont REPRIS du plan désigné par l'URL. Les
 * accepter permettrait de renommer ou de déplacer un plan sous couvert d'en
 * verser une version, et l'historique cesserait de décrire le même document.
 *
 * Seuls la discipline et la date peuvent légitimement changer d'une version à
 * l'autre — un plan corrigé porte une date plus récente.
 */
const deposerVersionSchema = Joi.object({
  format: Joi.string().valid('pdf', 'dwg', 'ifc').optional(),
  type_plan: Joi.string().trim().max(80).optional().allow(null, ''),
  date_plan: Joi.date().iso().max(new Date(Date.now() + 365 * 24 * 3600 * 1000))
    .optional().allow(null, ''),
});

/**
 * Contenu de `donnees` (colonne JSON de l'annotation).
 *
 * CAUSE DU CORRECTIF : ce champ était déclaré `Joi.object()` SANS AUCUNE CLÉ.
 * Un `Joi.object()` vide n'a pas de clés connues, donc `stripUnknown: true` du
 * middleware `validate` n'a rien à retirer : la structure entière du client
 * était persistée telle quelle, sans contrainte de type, de taille ni de forme.
 *
 * Conséquence concrète : `donnees.couleur` est réinjecté dans une propriété CSS
 * par le client admin. Une valeur comme `url("http://attaquant/pixel")` y
 * devient une REQUÊTE SORTANTE déclenchée au chargement du plan — fuite de
 * l'adresse IP du consultant et signal indiquant qui consulte quel plan, à
 * quelle heure. Même mécanique pour `donnees.url` d'une annotation de type
 * `lien` : `javascript:` ou `data:` y étaient acceptés.
 *
 * On déclare donc explicitement chaque clé attendue. Tout le reste est
 * silencieusement retiré par `stripUnknown`, et la charge utile est bornée
 * (longueurs de chaîne, nombre de points d'un tracé).
 */
const pointSchema = Joi.object({
  x: Joi.number().required(),
  y: Joi.number().required(),
});

const donneesAnnotationSchema = Joi.object({
  // Libellés / textes
  libelle: Joi.string().trim().max(200).allow('').optional(),
  texte: Joi.string().trim().max(2000).allow('').optional(),

  // Rendu — couleurs strictement hexadécimales (voir validations/common.js)
  couleur: couleurHex.optional(),
  couleurFond: couleurHex.optional(),
  epaisseur: Joi.number().min(0).max(50).optional(),
  opacite: Joi.number().min(0).max(1).optional(),
  taillePolice: Joi.number().integer().min(6).max(200).optional(),

  // Géométrie — tracés, cercles, rectangles, flèches, cotes
  points: Joi.array().items(pointSchema).max(2000).optional(),
  rayon: Joi.number().min(0).optional(),
  largeur: Joi.number().min(0).optional(),
  hauteur: Joi.number().min(0).optional(),
  angle: Joi.number().min(-360).max(360).optional(),

  // Mesures (type 'mesure')
  valeur: Joi.number().optional(),
  unite: Joi.string().trim().max(10).optional(),

  // Liens (type 'lien') — http(s) uniquement, jamais javascript:/data:
  url: urlHttp.optional(),
  reserveId: uuid.optional(),
}).optional().allow(null);

// Annotations (module 4) — marqueurs, dessins, mesures, repères GPS…
const creerAnnotationSchema = Joi.object({
  type: Joi.string().valid(
    'marqueur', 'dessin', 'mesure', 'texte', 'lien', 'cercle', 'rectangle', 'fleche'
  ).optional().default('marqueur'),
  x: Joi.number().optional().allow(null),
  y: Joi.number().optional().allow(null),
  latitude: Joi.number().min(-90).max(90).optional().allow(null),
  longitude: Joi.number().min(-180).max(180).optional().allow(null),
  // donnees : libellé, couleur, points du tracé, url du lien…
  donnees: donneesAnnotationSchema,
});

const modifierAnnotationSchema = creerAnnotationSchema.min(1);

/**
 * Hotspot — zone cliquable d'un plan (voir planHotspot.model.js).
 *
 * `x`/`y`/`largeur`/`hauteur` sont des POURCENTAGES de la page rendue, d'où
 * les bornes 0-100 : un repère hors de ces bornes est invisible et signale
 * une erreur d'unité côté client (des pixels envoyés à la place d'un ratio)
 * plutôt qu'une intention. On le refuse au lieu de l'enregistrer.
 */
const creerHotspotSchema = Joi.object({
  cible_type: Joi.string().valid('batiment', 'etage', 'zone').required(),
  cible_id: uuid.required(),
  libelle: Joi.string().trim().max(100).optional().allow('', null),
  x: Joi.number().min(0).max(100).required(),
  y: Joi.number().min(0).max(100).required(),
  largeur: Joi.number().min(0).max(100).optional().default(0),
  hauteur: Joi.number().min(0).max(100).optional().default(0),
  page: Joi.number().integer().min(1).max(10000).optional().default(1),
});

const modifierHotspotSchema = Joi.object({
  cible_type: Joi.string().valid('batiment', 'etage', 'zone').optional(),
  cible_id: uuid.optional(),
  libelle: Joi.string().trim().max(100).optional().allow('', null),
  x: Joi.number().min(0).max(100).optional(),
  y: Joi.number().min(0).max(100).optional(),
  largeur: Joi.number().min(0).max(100).optional(),
  hauteur: Joi.number().min(0).max(100).optional(),
  page: Joi.number().integer().min(1).max(10000).optional(),
}).min(1);

module.exports = { uploadPlanSchema, deposerVersionSchema, creerAnnotationSchema, modifierAnnotationSchema, creerHotspotSchema, modifierHotspotSchema };
