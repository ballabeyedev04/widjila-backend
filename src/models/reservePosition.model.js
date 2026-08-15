const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Position exacte d'une réserve sur un plan (coordonnées écran).
 * Règle métier : une réserve est liée à une position précise sur un plan.
 */
const ReservePosition = sequelize.define('ReservePosition', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true
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
  zoom: {
    type: DataTypes.FLOAT,
    allowNull: true,
    defaultValue: 1
  }
}, {
  tableName: 'reserve_positions',
  timestamps: true,
  underscored: true
});

module.exports = ReservePosition;
