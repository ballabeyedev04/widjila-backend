const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Historique d'un rapport — cahier des charges § 12 (REPORT_HISTORY) et § 18.
 *
 * Le § 18 en donne la forme attendue :
 *
 *   10/09/2026 - Rapport créé par utilisateur A
 *   10/09/2026 - PDF généré
 *   10/09/2026 - Envoyé à Entreprise ABC
 *   11/09/2026 - Rapport consulté via lien
 *   15/09/2026 - Nouvelle version générée
 *
 * Ces lignes ne sont JAMAIS modifiées ni supprimées : c'est ce qui distingue
 * un journal d'un champ « dernière action ». Un rapport déjà diffusé qu'on
 * régénère produit une nouvelle ligne, jamais une réécriture de l'ancienne —
 * la phrase de clôture du § 18 est explicite sur ce point.
 *
 * D'où l'absence d'`updatedAt` : rien ici ne se met à jour.
 */
const RapportHistorique = sequelize.define('RapportHistorique', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  rapportId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  /** cree, modifie, genere, envoye, partage, consulte_via_lien… */
  action: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  /**
   * Auteur de l'action. NUL pour une consultation par lien public : personne
   * n'est authentifié, et inventer un acteur ferait porter à quelqu'un un
   * geste qu'il n'a pas fait.
   */
  acteurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /** Destinataires d'un envoi, taille d'un fichier, origine d'un accès… */
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'rapport_historiques',
  timestamps: true,
  updatedAt: false,
  underscored: true,
  indexes: [
    { fields: ['rapport_id', 'created_at'] }
  ]
});

module.exports = RapportHistorique;
