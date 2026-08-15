'use strict';

const Joi = require('joi');
const { uuid, couleurHex, urlHttp } = require('../../../validations/common.js');

const uploadPlanSchema = Joi.object({
  chantierId: uuid.required(),
  zoneId: uuid.optional().allow(null),
  nom: Joi.string().trim().min(2).max(200).required(),
  format: Joi.string().valid('pdf', 'dwg', 'ifc').optional(),
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

module.exports = { uploadPlanSchema, creerAnnotationSchema, modifierAnnotationSchema };
