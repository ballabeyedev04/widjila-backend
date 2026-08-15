const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Inspection / OPR / visite contradictoire — contrôle qualité d'un chantier.
 * Peut produire un compte rendu et un rapport PDF.
 */
const Inspection = sequelize.define('Inspection', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  inspecteurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  type: {
    type: DataTypes.ENUM('inspection', 'opr', 'visite_contradictoire'),
    allowNull: false,
    defaultValue: 'inspection'
  },
  date_visite: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  statut: {
    type: DataTypes.ENUM('planifiee', 'en_cours', 'terminee', 'signee'),
    allowNull: false,
    defaultValue: 'planifiee'
  },
  compte_rendu: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  rapport_url: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'inspections',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['inspecteur_id'] }
  ]
});

module.exports = Inspection;
