const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Historique d'une réserve — traçabilité complète des modifications.
 * Règle métier : toute modification est historisée (auteur, date, valeurs).
 */
const ReserveHistorique = sequelize.define('ReserveHistorique', {
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
    allowNull: true
  },
  // Action : creation, modification, statut, commentaire, validation, refus, rouverture, cloture
  action: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  anciennes_valeurs: {
    type: DataTypes.JSON,
    allowNull: true
  },
  nouvelles_valeurs: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'reserve_historiques',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] }
  ]
});

module.exports = ReserveHistorique;
