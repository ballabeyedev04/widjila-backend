const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Commentaire sur une réserve — échanges entre les intervenants
 * (contrôleur, conducteur de travaux, entreprise…).
 */
const Commentaire = sequelize.define('Commentaire', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  }
}, {
  tableName: 'commentaires',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] }
  ]
});

module.exports = Commentaire;
