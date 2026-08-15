const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Média — photo, vidéo ou note vocale liée à une réserve.
 * Règle métier : chaque photo est horodatée (pris_le) et liée à sa réserve.
 */
const Media = sequelize.define('Media', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Photos d'inspection (module 6) — les médias sont soit liés à une
  // réserve, soit à une inspection.
  inspectionId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  type: {
    type: DataTypes.ENUM('photo', 'video', 'audio'),
    allowNull: false,
    defaultValue: 'photo'
  },
  url: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  thumbnail_url: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  latitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  longitude: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  largeur: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  hauteur: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  duree: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  // Empreinte SHA-256 — contrôle d'intégrité + dédoublonnage
  checksum: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  uploaderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  pris_le: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'medias',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] }
  ]
});

module.exports = Media;
