const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Destinataire d'un rapport — cahier des charges § 12 (REPORT_RECIPIENT) et
 * § 13 (envoi par e-mail).
 *
 * La ligne est écrite AU MOMENT DE L'ENVOI, une par adresse réellement
 * servie. Elle répond à la seule question qui compte trois semaines plus
 * tard : « qui a reçu ce rapport, quand, et sous quelle forme ». Sans elle,
 * la réponse serait « le serveur de messagerie le sait peut-être ».
 *
 * `mode` distingue les deux formes prévues par le § 13 : la pièce jointe pour
 * un rapport léger, le LIEN sécurisé pour un rapport lourd en photos.
 */
const RapportDestinataire = sequelize.define('RapportDestinataire', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  rapportId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  /** Membre de la plateforme, quand le destinataire en est un. */
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /** Entreprise / client de l'annuaire du chantier. */
  partenaireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  nom: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  /** 'to' (destinataire) ou 'cc' (copie). */
  role: {
    type: DataTypes.STRING(4),
    allowNull: false,
    defaultValue: 'to'
  },
  /** 'piece_jointe' ou 'lien'. */
  mode: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  envoye_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  /** en_attente, envoye, echec. */
  statut_envoi: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'en_attente'
  },
  erreur: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'rapport_destinataires',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['rapport_id'] }
  ]
});

module.exports = RapportDestinataire;
