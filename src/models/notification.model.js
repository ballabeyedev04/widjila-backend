const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Notification in-app — créée automatiquement sur les événements du cycle
 * de vie (nouvelle réserve, changement de statut, échéance, validation…).
 * Push/email relayés par notification.service (FCM + Resend).
 */
const Notification = sequelize.define('Notification', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Ex : reserve.cree, reserve.validee, reserve.en_retard, chantier.cloture
  type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  titre: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  lu_a: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Contexte JSON (reserveId, chantierId…) pour la navigation
  donnees: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'notifications',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['utilisateur_id'] },
    { fields: ['lu_a'] }
  ]
});

module.exports = Notification;
