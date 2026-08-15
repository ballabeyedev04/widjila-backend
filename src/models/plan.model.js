const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Plan numérique — import PDF/DWG/IFC avec versionning.
 * Chaque nouvel upload du même plan crée une version supérieure.
 * Les réserves restent liées à la version sur laquelle elles ont été posées.
 */
const Plan = sequelize.define('Plan', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  zoneId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  nom: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  fichier_url: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  format: {
    type: DataTypes.ENUM('pdf', 'dwg', 'ifc'),
    allowNull: false,
    defaultValue: 'pdf'
  },
  page_count: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  fichier_nom: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  uploaderId: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'plans',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['zone_id'] },
    // Une version d'un plan est unique DANS son chantier (audit § 6).
    // Sans cette contrainte, deux uploads simultanés du même plan créaient
    // silencieusement deux « version 3 », et la suppression de la dernière
    // version faisait réutiliser son numéro. L'index couvre aussi les lignes
    // soft-deleted (Postgres les indexe) : un numéro consommé ne revient pas.
    { name: 'plans_chantier_nom_version_unique', unique: true, fields: ['chantier_id', 'nom', 'version'] }
  ]
});

module.exports = Plan;
