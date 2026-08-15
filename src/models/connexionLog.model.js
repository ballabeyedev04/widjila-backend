const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * ConnexionLog — historique des connexions (module 1 / cahier des charges § Connexion).
 * Journal d'audit des authentifications : succès, échecs, IP, navigateur, méthode.
 * utilisateurId est nullable (les échecs sur email inconnu ne matchent aucun compte).
 */
const ConnexionLog = sequelize.define('ConnexionLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  succes: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  // Méthode d'authentification utilisée
  type: {
    type: DataTypes.ENUM('password', 'mfa', 'refresh'),
    allowNull: false,
    defaultValue: 'password'
  },
  ip: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Détails additionnels (motif d'échec…)
  donnees: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'connexion_logs',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['utilisateur_id'] },
    { fields: ['email'] },
    { fields: ['created_at'] }
  ]
});

module.exports = ConnexionLog;
