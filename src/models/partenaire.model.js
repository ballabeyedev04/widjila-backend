const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Partenaire — tiers liés à un chantier ou à l'organisation (module 2 /
 * cahier des charges § Clients / MOA / MOE / sous-traitants).
 * Types : client (MOA), maître d'ouvrage, maître d'œuvre, sous-traitant,
 * fournisseur, bureau de contrôle.
 */
const Partenaire = sequelize.define('Partenaire', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  nom: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('client', 'maitre_ouvrage', 'maitre_oeuvre', 'sous_traitant', 'fournisseur', 'bureau_controle', 'autre'),
    allowNull: false,
    defaultValue: 'client'
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  telephone: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  contact: {
    type: DataTypes.STRING(150),
    allowNull: true
  },
  adresse: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'partenaires',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['chantier_id'] },
    { fields: ['type'] }
  ]
});

module.exports = Partenaire;
