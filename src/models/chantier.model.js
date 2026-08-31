const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { STATUT_CHANTIER } = require('../config/enums.js');

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
  //
  // VARCHAR et non ENUM : la liste des statuts vit dans `config/enums.js`, et
  // un ENUM PostgreSQL demanderait une migration à chaque valeur ajoutée.
  statut: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'en_preparation',
    validate: { isIn: [STATUT_CHANTIER] }
  },

  // ── Circuit de validation ─────────────────────────────────────────────────
  // Un chantier créé par un compte non-Admin naît « en_attente_validation ».
  // Les trois champs qui suivent tracent QUI a demandé, QUI a tranché et
  // POURQUOI en cas de refus — sans quoi un demandeur voit sa demande refusée
  // sans savoir quoi corriger.
  demandeurId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'utilisateur', key: 'id' }
  },
  motifRejet: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  valideParId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'utilisateur', key: 'id' }
  },
  valideLe: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'chantiers',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['statut'] },
    { fields: ['demandeur_id'] },
    { fields: ['responsable_id'] }
  ]
});

module.exports = Chantier;
