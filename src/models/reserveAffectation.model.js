const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * ReserveAffectation — affectations multiples d'une réserve
 * (module 5 / cahier des charges § Affectation de la réserve à plusieurs
 * intervenants). Une réserve peut être affectée à plusieurs utilisateurs
 * et/ou entreprises en parallèle (le champ assigneA reste l'affectation
 * principale).
 */
const ReserveAffectation = sequelize.define('ReserveAffectation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /**
   * Entreprise UTILISATRICE de la plateforme (table `organisations`).
   *
   * Ne convient qu'aux entreprises qui ont leur propre compte : c'est ce champ
   * qui fait apparaître la réserve dans LEUR espace. La plupart des entreprises
   * d'un chantier n'en ont pas — voir `partenaireId` juste en dessous.
   */
  entrepriseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /**
   * Entreprise de l'ANNUAIRE du chantier (table `partenaires`).
   *
   * C'est le cas COURANT, et il manquait. L'écran « Choisir qui affecter » du
   * mobile propose l'annuaire dans son onglet « Intervenant », mais envoyait
   * l'identifiant retenu dans `entrepriseId` : le serveur cherchait alors une
   * organisation portant un identifiant de partenaire, n'en trouvait aucune, et
   * répondait « Entreprise introuvable » pour une entreprise qui existait.
   *
   * Même division du travail que sur la réserve elle-même
   * (`reserve.model.js`) : `partenaireId` dit QUI est responsable,
   * `entrepriseId` dit à quel espace client l'affectation doit apparaître.
   */
  partenaireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_affectation: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'reserve_affectations',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['reserve_id'] },
    { fields: ['utilisateur_id'] },
    { fields: ['entreprise_id'] },
    { fields: ['partenaire_id'] }
  ]
});

module.exports = ReserveAffectation;
