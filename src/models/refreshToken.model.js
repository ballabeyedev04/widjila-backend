const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Table de stockage des refresh tokens.
 * Stockage du hash SHA-256 uniquement — le token brut n'est jamais persisté.
 * Rotation forcée à chaque refresh (l'ancien token est révoqué).
 */
const RefreshToken = sequelize.define('RefreshToken', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  // SHA-256 hex du token JWT (exactement 64 caractères)
  tokenHash: {
    type: DataTypes.CHAR(64),
    allowNull: false,
    unique: true
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  revoked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  // Date à laquelle ce jeton a été REMPLACÉ par une rotation (null sinon).
  // Son rejeu après cette date signale un vol — voir AuthService.refresh
  // (audit sécurité SC-04). Une révocation volontaire (déconnexion,
  // changement de mot de passe) laisse ce champ à null.
  rotatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'refresh_tokens',
  timestamps: true,
  underscored: true,
  indexes: [
    // Lookup par hash (unique couvre déjà ce cas — index explicite pour lisibilité)
    { unique: true, fields: ['token_hash'] },
    // Purge des tokens expirés : WHERE utilisateur_id = ? AND expires_at < NOW()
    { fields: ['utilisateur_id', 'expires_at'] }
  ]
});

module.exports = RefreshToken;
