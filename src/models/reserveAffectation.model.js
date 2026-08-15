const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * ReserveAffectation — affectations multiples d'une réserve
 * (module 5 / cahier des charges § Affectation de la réserve à plusieurs
 * intervenants). Une réserve peut être affectée à plusieurs utilisateurs
 * et/ou entreprises en parallèle (le champ assigneA reste l'affectation
 * principale).
 */
const ReserveAffectation = sequelize.define('ReserveAffectation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  entrepriseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_affectation: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'reserve_affectations',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] },
    { fields: ['utilisateur_id'] },
    { fields: ['entreprise_id'] }
  ]
});

module.exports = ReserveAffectation;
