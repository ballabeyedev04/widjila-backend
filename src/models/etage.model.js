const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Étage / niveau — second niveau de décomposition.
 * Exemple : "RDC", "Étage 1", "Sous-sol -1".
 */
const Etage = sequelize.define('Etage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  batimentId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  niveau: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0
  }
}, {
  tableName: 'etages',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['batiment_id'] }
  ]
});

module.exports = Etage;
