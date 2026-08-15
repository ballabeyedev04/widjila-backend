const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Zone — logement, pièce ou zone technique. Niveau le plus fin de
 * localisation d'une réserve (avec l'étage et le bâtiment).
 */
const Zone = sequelize.define('Zone', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  etageId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('logement', 'piece', 'zone', 'local'),
    allowNull: false,
    defaultValue: 'zone'
  }
}, {
  tableName: 'zones',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['etage_id'] }
  ]
});

module.exports = Zone;
