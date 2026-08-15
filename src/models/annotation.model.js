const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Annotation — élément graphique posé sur un plan (module 4).
 * Types : marqueur, dessin, mesure, texte, lien, cercle, rectangle, flèche.
 * Repère GPS : latitude/longitude (les repères GPS sont une annotation
 * de type 'marqueur' avec coordonnées).
 * donnees (JSON) : libellé, couleur, épaisseur, points, url du lien…
 */
const Annotation = sequelize.define('Annotation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  planId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('marqueur', 'dessin', 'mesure', 'texte', 'lien', 'cercle', 'rectangle', 'fleche'),
    allowNull: false,
    defaultValue: 'marqueur'
  },
  // Position (en coordonnées normalisées du plan 0..1 ou en pixels selon convention)
  x: {
    type: DataTypes.DECIMAL(10, 6),
    allowNull: true
  },
  y: {
    type: DataTypes.DECIMAL(10, 6),
    allowNull: true
  },
  // Repère GPS associé (facultatif)
  latitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  longitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  // Données spécifiques au type (libellé, points d'un tracé, couleur…)
  donnees: {
    type: DataTypes.JSON,
    allowNull: true
  },
  creePar: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'annotations',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['plan_id'] }
  ]
});

module.exports = Annotation;
