const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Signature — signature électronique apposée sur une entité
 * (réserve, document, inspection — module 5, 6 et 7).
 *
 * Modèle polymorphe : cibleType + cibleId désignent la ressource signée
 * (pas de contrainte FK en base, résolue par le service).
 * donnees : dataURL de la signature (dessin tactile) ou métadonnées.
 */
const Signature = sequelize.define('Signature', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  cibleType: {
    type: DataTypes.ENUM('reserve', 'document', 'inspection'),
    allowNull: false
  },
  cibleId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Nature de la signature
  type: {
    type: DataTypes.ENUM('signature', 'validation', 'refus'),
    allowNull: false,
    defaultValue: 'signature'
  },
  // DataURL image (PNG) de la signature, ou JSON de métadonnées
  donnees: {
    type: DataTypes.JSON,
    allowNull: true
  },
  signe_le: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'signatures',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['cible_type', 'cible_id'] },
    { fields: ['utilisateur_id'] }
  ]
});

module.exports = Signature;
