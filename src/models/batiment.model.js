const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Bâtiment — premier niveau de la décomposition d'un chantier.
 * Exemple : "Bâtiment A", "Résidence Horizon B".
 */
const Batiment = sequelize.define('Batiment', {
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
    type: DataTypes.STRING(100),
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: true
  }
}, {
  tableName: 'batiments',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] }
  ]
});

module.exports = Batiment;
