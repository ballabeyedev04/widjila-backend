const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Journal d'audit — trace les actions sensibles (connexion, création de
 * réserve, validation, changement de rôle, suppression…).
 * Écriture best-effort : ne doit jamais faire échouer l'action principale.
 */
const AuditLog = sequelize.define('AuditLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  adminId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Snapshot du nom/email de l'utilisateur au moment de l'action — reste
  // lisible même si le compte est supprimé par la suite.
  adminNom: {
    type: DataTypes.STRING,
    allowNull: true
  },
  adminEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cibleType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  cibleId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  details: {
    type: DataTypes.JSON,
    allowNull: true
  },
  ip: {
    type: DataTypes.STRING(50),
    allowNull: true
  }
}, {
  tableName: 'audit_log',
  timestamps: true,
  indexes: [
    { fields: ['adminId'] },
    { fields: ['createdAt'] }
  ]
});

module.exports = AuditLog;
