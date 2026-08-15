const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Équipe — groupe de travail au sein d'une organisation.
 * Un utilisateur peut appartenir à plusieurs équipes (many-to-many).
 */
const Equipe = sequelize.define('Equipe', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'equipes',
  timestamps: true,
  paranoid: true,
  underscored: true
});

module.exports = Equipe;
