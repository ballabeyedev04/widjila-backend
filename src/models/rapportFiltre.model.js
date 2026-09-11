const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Filtre d'un rapport — cahier des charges § 12, table REPORT_FILTER.
 *
 * ── Une ligne par VALEUR retenue ───────────────────────────────────────────
 *
 * Le § 4 décrit des sélections multiples : « Entreprise : Toutes ou
 * sélection », « Corps d'état : Tous ou sélection ». Une ligne unique à
 * colonnes scalaires n'aurait pas pu porter deux entreprises — il aurait
 * fallu en choisir une, et le rapport aurait alors annoncé un périmètre
 * différent de celui qu'il contient.
 *
 * Chaque ligne renseigne donc UNE dimension : un bâtiment, ou un étage, ou
 * une entreprise, ou un intervalle de dates. Le rapport les combine.
 *
 * ── Pourquoi une table alors que `rapports.filtres` porte déjà le JSON ─────
 *
 * Le JSON est la configuration telle que le client l'a envoyée : c'est lui
 * qui est rejoué à la régénération. Cette table sert aux QUESTIONS que le
 * JSON ne sait pas répondre — « quels rapports concernent cette entreprise »,
 * « ce bâtiment a-t-il déjà été rapporté ce mois-ci ». Les deux sont écrits
 * dans la même transaction.
 */
const RapportFiltre = sequelize.define('RapportFiltre', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  rapportId: {
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
  /** Entreprise réelle de l'annuaire du chantier (`company_id` du § 8). */
  partenaireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  corpsEtatId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /** Statut du RAPPORT (A_TRAITER, EN_COURS…), pas statut de réserve. */
  statut: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  /** CRITIQUE, MAJEURE ou MINEURE. */
  gravite: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  date_debut: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  date_fin: {
    type: DataTypes.DATEONLY,
    allowNull: true
  }
}, {
  tableName: 'rapport_filtres',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['rapport_id'] }
  ]
});

module.exports = RapportFiltre;
