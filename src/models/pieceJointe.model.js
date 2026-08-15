const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * PieceJointe — document joint à une réserve (module 5 / pièces jointes).
 * Distinct des médias (photos/vidéos) : pièces contractuelles, devis,
 * factures, procès-verbaux attachés à la réserve.
 */
const PieceJointe = sequelize.define('PieceJointe', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom_fichier: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  fichier_url: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  mime_type: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  taille: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  uploaderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Empreinte SHA-256 — intégrité du document
  checksum: {
    type: DataTypes.STRING(64),
    allowNull: true
  }
}, {
  tableName: 'pieces_jointes',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] }
  ]
});

module.exports = PieceJointe;
