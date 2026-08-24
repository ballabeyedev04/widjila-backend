const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Demande de suppression de compte déposée depuis la page PUBLIQUE
 * `/suppression-compte` (exigence Google Play : une URL accessible sans
 * connexion et sans avoir l'application installée).
 *
 * Volontairement DÉCOUPLÉE de la table `utilisateurs` :
 *   - le demandeur n'est pas authentifié, on ne peut donc pas lui faire
 *     confiance sur l'identité qu'il déclare ;
 *   - il peut avoir déjà désinstallé l'app, voire ne jamais avoir eu de
 *     compte sous cette adresse. Une clé étrangère rejetterait la demande
 *     au lieu de l'enregistrer, et on perdrait la trace d'une sollicitation
 *     à laquelle le RGPD impose de répondre sous 30 jours.
 *
 * Le rapprochement avec un compte réel est fait À LA MAIN par l'admin, qui
 * vérifie l'identité avant de supprimer quoi que ce soit.
 */
const DemandeSuppression = sequelize.define('DemandeSuppression', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  email: {
    type: DataTypes.STRING(320), // RFC 5321
    allowNull: false
  },
  objet: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  statut: {
    type: DataTypes.ENUM('en_attente', 'traitee', 'rejetee'),
    allowNull: false,
    defaultValue: 'en_attente'
  },
  // Trace d'origine — sert à repérer un dépôt automatisé en masse. Nullable :
  // derrière un proxy mal configuré, l'IP peut manquer, ce qui ne doit pas
  // faire échouer l'enregistrement de la demande.
  ip: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  traite_par: {
    type: DataTypes.UUID,
    allowNull: true
  },
  traite_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  note_admin: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'demandes_suppression',
  timestamps: true,
  underscored: true,
  indexes: [
    // La file de travail de l'admin : filtrée par statut, triée par date.
    { fields: ['statut', 'created_at'] },
    // Repérage des doublons pour une même adresse.
    { fields: ['email'] }
  ]
});

module.exports = DemandeSuppression;
