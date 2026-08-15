const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Réserve — la table centrale du produit (voir cahier des charges, module 5).
 * Cycle de vie : creee → affectee → en_cours → corrigee → a_verifier →
 *               validee / refusee → (rouverte) → cloturee.
 *
 * Règles métier importantes :
 *   - une réserve ne peut être validée qu'avec des preuves de correction ;
 *   - une réserve validée ne peut pas être supprimée ;
 *   - toute modification est tracée dans reserve_historiques ;
 *   - une réserve est liée à une position (x, y) sur un plan.
 */
const Reserve = sequelize.define('Reserve', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  // Numéro automatique (R-0001) — attribué par le service au moment de la
  // création. La numérotation repart à 1 sur CHAQUE chantier : l'unicité doit
  // donc être composite (chantier_id, numero) et non globale, sinon le second
  // chantier ne peut jamais créer sa première réserve.
  // Voir l'index unique déclaré plus bas.
  numero: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  batimentId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  etageId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  zoneId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  planId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  lotId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  titre: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  severite: {
    type: DataTypes.ENUM('faible', 'moyenne', 'haute', 'critique'),
    allowNull: false,
    defaultValue: 'moyenne'
  },
  priorite: {
    type: DataTypes.ENUM('faible', 'moyenne', 'haute', 'critique'),
    allowNull: false,
    defaultValue: 'moyenne'
  },
  // Catégorie de la réserve (module 5 / cahier des charges § Catégorie)
  categorie: {
    type: DataTypes.ENUM('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre'),
    allowNull: true,
    defaultValue: 'autre'
  },
  statut: {
    type: DataTypes.ENUM('creee', 'affectee', 'en_cours', 'corrigee', 'a_verifier', 'validee', 'refusee', 'rouverte', 'en_retard', 'cloturee'),
    allowNull: false,
    defaultValue: 'creee'
  },
  // Entreprise (organisation) en charge de la correction
  entrepriseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Utilisateur auquel la réserve est affectée
  assigneA: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_limite: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  creePar: {
    type: DataTypes.UUID,
    allowNull: false
  },
  validePar: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_validation: {
    type: DataTypes.DATE,
    allowNull: true
  },
  motif_refus: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'reserves',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['statut'] },
    { fields: ['entreprise_id'] },
    { fields: ['assigne_a'] },
    // Un numéro est unique DANS son chantier, pas dans toute la base.
    { name: 'reserves_chantier_numero_unique', unique: true, fields: ['chantier_id', 'numero'] }
  ]
});

module.exports = Reserve;
