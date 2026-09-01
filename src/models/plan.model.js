const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { STATUT_PLAN } = require('../config/enums.js');

/**
 * Plan numérique — import PDF/DWG/IFC avec versionning.
 * Chaque nouvel upload du même plan crée une version supérieure.
 * Les réserves restent liées à la version sur laquelle elles ont été posées.
 */
const Plan = sequelize.define('Plan', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // ── Rattachement à la structure ────────────────────────────────────────────
  //
  // Un plan se rattache au niveau qu'il DÉCRIT, et ces niveaux sont exclusifs
  // en pratique :
  //   - aucun des trois  → plan global du chantier (la vue d'ensemble) ;
  //   - batimentId seul  → plan d'un bâtiment ;
  //   - etageId          → plan d'un étage ou d'un sous-sol ;
  //   - zoneId           → plan d'un appartement / d'une pièce.
  //
  // `zoneId` existait seul : impossible d'attacher un plan d'étage sans
  // inventer une zone fictive, et le parcours « bâtiment → étages →
  // appartements » du guide client ne pouvait donc pas être alimenté.
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
  nom: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  fichier_url: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  format: {
    type: DataTypes.ENUM('pdf', 'dwg', 'ifc'),
    allowNull: false,
    defaultValue: 'pdf'
  },
  page_count: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  fichier_nom: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  uploaderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /**
   * Cycle de validation du plan.
   *
   * Un plan déposé avec une demande de chantier attend la même validation que
   * le chantier auquel il est joint. Sans ce statut, il serait indiscernable
   * d'un plan validé et des équipes y poseraient des réserves sur un chantier
   * qui n'existe pas encore.
   *
   * Défaut `actif` : un plan déposé sur un chantier DÉJÀ validé est
   * immédiatement exploitable — c'est le cas courant, et le circuit ne doit
   * rien changer au parcours existant.
   */
  statut: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'actif',
    validate: { isIn: [STATUT_PLAN] }
  }
}, {
  tableName: 'plans',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['zone_id'] },
    { fields: ['batiment_id'] },
    { fields: ['etage_id'] },
    // Une version d'un plan est unique DANS son chantier (audit § 6).
    // Sans cette contrainte, deux uploads simultanés du même plan créaient
    // silencieusement deux « version 3 », et la suppression de la dernière
    // version faisait réutiliser son numéro. L'index couvre aussi les lignes
    // soft-deleted (Postgres les indexe) : un numéro consommé ne revient pas.
    { name: 'plans_chantier_nom_version_unique', unique: true, fields: ['chantier_id', 'nom', 'version'] }
  ]
});

module.exports = Plan;
