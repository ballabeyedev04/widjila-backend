const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Phase — DEUX usages dans une seule table, distingués par `chantierId`.
 *
 *   chantierId RENSEIGNÉ → phase de PLANNING d'un chantier (module 3) :
 *       "Terrassement", "Gros œuvre"…, avec dates et statut. Alimente le
 *       calendrier. Comportement historique, inchangé.
 *
 *   chantierId NULL      → phase du RÉFÉRENTIEL, à laquelle les réserves se
 *       rattachent : "Pré-cloisons", "Cloisons", "OPR", "Réception", "GPA"…
 *       Administrable, ordonnée, commune à tous les chantiers.
 *
 * `organisationId` suit la même convention que `corpsEtat` : NULL = référentiel
 * standard de la plateforme, renseigné = phase propre à une organisation.
 *
 * Les deux usages partagent nom, description et ordre — c'est ce qui a fait
 * préférer l'extension de cette table à la création d'une seconde, qui aurait
 * dupliqué modèle, routes et écrans sans qu'on sache laquelle fait foi.
 * Voir la migration 20260829000007-phase-referentiel.js.
 */
const Phase = sequelize.define('Phase', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  // NULL = phase du référentiel (voir l'en-tête). Renseigné = phase de
  // planning appartenant à ce chantier.
  chantierId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // NULL = référentiel standard de la plateforme ; renseigné = phase propre
  // à une organisation. Sans objet pour une phase de planning.
  organisationId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  nom: {
    type: DataTypes.STRING(150),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  date_debut: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  date_fin: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  statut: {
    type: DataTypes.ENUM('planifiee', 'en_cours', 'terminee'),
    allowNull: false,
    defaultValue: 'planifiee'
  },
  /**
   * Une phase retirée du référentiel est DÉSACTIVÉE, jamais supprimée : les
   * réserves déjà rattachées gardent leur phase d'origine, et la phase cesse
   * simplement d'être proposée à la création d'une réserve.
   */
  actif: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  }
}, {
  tableName: 'phases',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['organisation_id'] },
    { fields: ['actif'] }
    // Les index d'unicité du référentiel sont PARTIELS : posés par la
    // migration, Sequelize ne sait pas les décrire ici.
  ]
});

module.exports = Phase;
