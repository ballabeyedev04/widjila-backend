const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * ChantierMembre — affectation d'un utilisateur à plusieurs chantiers
 * (module 1 / cahier des charges § Affectation à plusieurs projets).
 * Un utilisateur peut être affecté à 0..n chantiers ; le rôle sur le
 * chantier peut différer de son rôle global dans l'organisation.
 */
const ChantierMembre = sequelize.define('ChantierMembre', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Rôle spécifique au chantier (optionnel) : 'responsable', 'intervenant'…
  roleChantier: {
    type: DataTypes.STRING(50),
    allowNull: true
  }
}, {
  tableName: 'chantier_membres',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['chantier_id', 'utilisateur_id'] },
    { fields: ['utilisateur_id'] }
  ]
});

module.exports = ChantierMembre;
