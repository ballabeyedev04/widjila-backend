const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * MfaChallenge — jeton MFA éphémère émis au login quand le MFA est activé.
 *
 * Sécurité (cf. audit) : le jeton est à USAGE UNIQUE (supprimé après le
 * premier appel à verifierMfa) et porte un compteur de tentatives TOTP :
 * au-delà de MFA_MAX_TENTATIVES, le challenge est détruit et l'utilisateur
 * doit refaire un login complet. Empêche le rejeu du mfaToken et le
 * brute-force du code TOTP par rotation d'IP.
 */
const MfaChallenge = sequelize.define('MfaChallenge', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // Hash SHA-256 du jeton — le jeton brut n'est jamais stocké.
  tokenHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  tentatives: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'mfa_challenge',
  timestamps: true,
  indexes: [
    { fields: ['utilisateurId'] },
    { fields: ['expiresAt'] },
  ],
});

module.exports = MfaChallenge;
