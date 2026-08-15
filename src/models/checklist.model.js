const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Élément d'une checklist d'inspection (ligne de contrôle cochable).
 */
const Checklist = sequelize.define('Checklist', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  inspectionId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  libelle: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  coche: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  commentaire: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'checklists',
  timestamps: true,
  // Paranoid (audit § 4) : sans deleted_at, la suppression d'une inspection
  // (soft delete) laissait ses lignes de contrôle actives et orphelines — le
  // `onDelete: CASCADE` déclaré sur l'association ne se déclenche que sur un
  // DELETE physique, jamais sur un UPDATE deleted_at. La checklist suit
  // désormais le sort de son inspection.
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['inspection_id'] }
  ]
});

module.exports = Checklist;
