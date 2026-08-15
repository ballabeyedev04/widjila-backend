const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Phase — décomposition temporelle d'un chantier (module 3 / planning).
 * Exemple : "Terrassement", "Gros œuvre", "Second œuvre", "Réception".
 * Sert de base au calendrier / planning du chantier.
 */
const Phase = sequelize.define('Phase', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(150),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  date_debut: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  date_fin: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  statut: {
    type: DataTypes.ENUM('planifiee', 'en_cours', 'terminee'),
    allowNull: false,
    defaultValue: 'planifiee'
  }
}, {
  tableName: 'phases',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] }
  ]
});

module.exports = Phase;
