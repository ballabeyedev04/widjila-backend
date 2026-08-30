const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Zone cliquable posée sur un plan — le maillon qui rend le parcours du guide
 * client réellement navigable (« plan global → bâtiment → étage → appartement »).
 *
 * Sur le plan global du chantier, un hotspot pointe vers un BÂTIMENT ; sur un
 * plan de bâtiment, vers un ÉTAGE ; sur un plan d'étage, vers une ZONE
 * (l'appartement). Le client clique la forme, l'application descend d'un
 * niveau. Quand aucun hotspot n'a été dessiné, les clients retombent sur des
 * cartes de navigation — le parcours n'est jamais bloqué par une saisie
 * manquante.
 *
 * COORDONNÉES : `x`, `y`, `largeur` et `hauteur` sont des POURCENTAGES
 * (0-100) de la page rendue, jamais des pixels. C'est la même convention que
 * `ReservePosition` : le plan est rendu à une taille qui dépend de l'écran et
 * du zoom, seul un repère relatif reste juste d'un appareil à l'autre.
 *
 * `cible_type` + `cible_id` forment une association polymorphe. Elle n'est
 * donc PAS portée par une clé étrangère : le nettoyage des hotspots orphelins
 * est fait explicitement à la suppression d'un bâtiment/étage/zone (voir
 * chantier.service.js), et la lecture tolère une cible disparue.
 */
const PlanHotspot = sequelize.define('PlanHotspot', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  planId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  cible_type: {
    type: DataTypes.ENUM('batiment', 'etage', 'zone'),
    allowNull: false
  },
  cible_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Libellé affiché sur la pastille (« BÂTIMENT A »). Facultatif : à défaut,
  // les clients affichent le nom de la cible.
  libelle: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  x: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  y: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  // Un hotspot de largeur/hauteur nulle est un simple POINT — c'est le cas par
  // défaut, suffisant pour poser un repère cliquable sans dessiner de cadre.
  largeur: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  hauteur: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  // Page du PDF concernée (1-indexée) — un plan multi-pages porte souvent un
  // niveau par page.
  page: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  }
}, {
  tableName: 'plan_hotspots',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['plan_id'] },
    { fields: ['cible_type', 'cible_id'] }
  ]
});

module.exports = PlanHotspot;
