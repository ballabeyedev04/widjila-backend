const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Lot technique / corps d'état — regroupement fonctionnel d'un chantier.
 * Exemple : "Gros œuvre", "Électricité", "Plomberie", "Peinture".
 */
const Lot = sequelize.define('Lot', {
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
  },
  corps_d_etat: {
    type: DataTypes.STRING(100),
    allowNull: true
  }
}, {
  tableName: 'lots',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] }
  ]
});

module.exports = Lot;
