const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Chantier (projet) — l'unité principale de la plateforme.
 * Un chantier appartient à une organisation et possède bâtiments, étages,
 * zones, lots, plans, réserves, documents et inspections.
 */
const Chantier = sequelize.define('Chantier', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  nom: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  adresse: {
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
  date_debut: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  date_fin: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  // Responsable du chantier (userId)
  responsableId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  budget: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  // 'cloture' refusée si réserves ouvertes (règle métier — service reserve)
  statut: {
    type: DataTypes.ENUM('en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture'),
    allowNull: false,
    defaultValue: 'en_preparation'
  }
}, {
  tableName: 'chantiers',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['statut'] },
    { fields: ['responsable_id'] }
  ]
});

module.exports = Chantier;
