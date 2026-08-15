const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Rapport généré — historique des rapports PDF (visite, OPR, réserves…).
 * Les rapports reflètent l'état des données au moment de la génération.
 */
const Rapport = sequelize.define('Rapport', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Ex : visite, opr, reserves, entreprise, batiment, qualite
  type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  fichier_url: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  generePar: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Paramètres de génération (filtres appliqués) — pour traçabilité
  parametres: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'rapports',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] }
  ]
});

module.exports = Rapport;
