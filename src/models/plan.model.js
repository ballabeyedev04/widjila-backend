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
  // Plan PARENT — un plan de détail à l'intérieur d'un autre plan.
  //
  // Nul pour l'immense majorité des plans : leur place vient alors de leurs
  // liens de structure (`batimentId`, `etageId`, `zoneId`), qui restent la
  // source de vérité pour « dans quel bâtiment, à quel étage ».
  //
  // Renseigné, il ouvre une profondeur quelconque SOUS le dernier niveau de
  // structure — le plan d'une pièce dans un appartement, celui d'une façade
  // dans un bâtiment. Le plan de détail hérite alors des liens de structure de
  // son parent (plan.service.js#upload) : une réserve posée dessus reste
  // localisée dans la bonne zone, ce dont dépendent les rapports et les
  // filtres.
  //
  // Voir la migration 20260907000001 pour le raisonnement complet.
  parentId: {
    type: DataTypes.UUID,
    allowNull: true,
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
  /**
   * Version COURANTE du plan — cahier technique § 10 et § 15.
   *
   * « La version courante est identifiée par is_current = true ».
   *
   * Le code la déduisait du plus grand numéro de version. C'était équivalent
   * tant qu'on ne voulait rien d'autre, mais le § 15 demande de pouvoir
   * « afficher clairement la version active » sans déplacer automatiquement
   * les réserves — donc de désigner la version courante, et pas seulement de
   * la calculer.
   *
   * Une seule version d'un plan est courante à la fois : le dépôt bascule la
   * précédente à `false` dans la même transaction.
   */
  is_current: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  /**
   * Discipline du plan — « Architecture », « Électricité », « Plomberie »…
   * (cahier technique § 4, champ « Type »).
   *
   * Texte libre borné et NON un ENUM : le document dit « etc. ». Un ENUM
   * imposerait une migration à chaque discipline nouvelle — désenfumage,
   * courants faibles, VRD — pour une donnée qui n'entre dans aucune règle
   * métier et ne sert qu'à ranger et à filtrer.
   *
   * À ne pas confondre avec `format` juste en dessous, qui décrit le FICHIER
   * (pdf, dwg, ifc) et non son contenu.
   */
  type_plan: {
    type: DataTypes.STRING(80),
    allowNull: true
  },
  /**
   * Date DU PLAN (cahier technique § 4), distincte de `createdAt` qui est la
   * date de DÉPÔT.
   *
   * Un plan daté du 3 mars peut être versé en septembre : confondre les deux
   * ferait croire que le chantier travaille sur un document récent.
   */
  date_plan: {
    type: DataTypes.DATEONLY,
    allowNull: true
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
    { fields: ['chantier_id', 'type_plan'] },
    // Une version d'un plan est unique DANS son chantier (audit § 6).
    // Sans cette contrainte, deux uploads simultanés du même plan créaient
    // silencieusement deux « version 3 », et la suppression de la dernière
    // version faisait réutiliser son numéro. L'index couvre aussi les lignes
    // soft-deleted (Postgres les indexe) : un numéro consommé ne revient pas.
    { name: 'plans_chantier_nom_version_unique', unique: true, fields: ['chantier_id', 'nom', 'version'] }
  ]
});

module.exports = Plan;
