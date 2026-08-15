const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * ChecklistModele — modèle de checklist réutilisable pour les inspections
 * (module 6 / cahier des charges § Modèles de checklist).
 * items : tableau de { libelle, categorie } — utilisé pour préremplir la
 * checklist d'une inspection à sa création.
 */
const ChecklistModele = sequelize.define('ChecklistModele', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(150),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  items: {
    type: DataTypes.JSON,
    allowNull: true
  },
  creePar: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'checklist_modeles',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] }
  ]
});

module.exports = ChecklistModele;
