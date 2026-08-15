const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Convocation — convocation / présence à une inspection (module 6 /
 * cahier des charges § Convocations & présence). Chaque participant
 * répond (invité → accepté/décliné) puis sa présence est pointée
 * (présent / absent) le jour de la visite.
 */
const Convocation = sequelize.define('Convocation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  inspectionId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  statut: {
    type: DataTypes.ENUM('invite', 'accepte', 'decline', 'present', 'absent'),
    allowNull: false,
    defaultValue: 'invite'
  },
  repondu_le: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'convocations',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['inspection_id'] },
    { unique: true, fields: ['inspection_id', 'utilisateur_id'] }
  ]
});

module.exports = Convocation;
