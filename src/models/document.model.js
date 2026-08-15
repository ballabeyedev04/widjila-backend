const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Document — GED du chantier (DOE, contrats, PV, comptes rendus, rapports…).
 * Versionning : chaque nouvel upload incrémente la version du document.
 */
const Document = sequelize.define('Document', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('plan', 'contrat', 'doe', 'pv', 'compte_rendu', 'rapport', 'notice', 'photo', 'autre'),
    allowNull: false,
    defaultValue: 'autre'
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
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  uploaderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Archivage explicite (module 7 / cahier des charges § Archivage)
  statut: {
    type: DataTypes.ENUM('actif', 'archive'),
    allowNull: false,
    defaultValue: 'actif'
  },
  // Signature électronique du document (utilisateur signataire)
  signataireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  signe_le: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'documents',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['type'] },
    // Une version d'un document est unique DANS son chantier (audit § 6) —
    // même raison que pour les plans : course entre deux téléversements
    // simultanés, et réutilisation du numéro après suppression de la dernière
    // version (l'index couvre aussi les lignes soft-deleted).
    { name: 'documents_chantier_nom_version_unique', unique: true, fields: ['chantier_id', 'nom_fichier', 'version'] }
  ]
});

module.exports = Document;
