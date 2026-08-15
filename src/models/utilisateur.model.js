const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/**
 * Utilisateur — membre d'une organisation sur la plateforme.
 * Multi-tenant : organisationId rattache l'utilisateur à son entreprise.
 * Le super-admin plateforme (role 'Admin') peut être sans organisation.
 */
const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  nom: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  prenom: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: { isEmail: true }
  },
  mot_de_passe: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  telephone: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  photoProfil: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  // Fonction sur le chantier (libellé libre : "Chef de chantier", "Électricien"…)
  fonction: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  // Rôles métier — voir cahier des charges, section "Acteurs"
  role: {
    type: DataTypes.ENUM('Admin', 'ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise', 'Client', 'MaitreOuvrage', 'MaitreOeuvre'),
    defaultValue: 'ConducteurTravaux',
    allowNull: false
  },
  // 'en_attente_validation' : compte créé par un admin, en attente d'activation.
  // Ce statut n'impose AUCUNE restriction d'accès — seul 'inactif' bloque.
  statut: {
    type: DataTypes.ENUM('actif', 'inactif', 'en_attente_validation'),
    defaultValue: 'actif'
  },
  // Permissions fines accordées à un administrateur (ex: ['chantiers','reserves']).
  // ['all'] = accès total (super-admin). null / [] = compte restreint.
  permissions: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null
  },
  langue: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'fr'
  },
  dernierConnexion: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // ── Authentification à deux facteurs (module 1 / MFA) ──
  // Secret TOTP (otplib). Chiffré AES-256-GCM au repos (APP_ENC_KEY) —
  // le getter déchiffre à la lecture, jamais exposé dans les réponses API.
  mfa_secret: {
    type: DataTypes.STRING(512),
    allowNull: true,
    get() {
      const raw = this.getDataValue('mfa_secret');
      return raw ? decrypt(raw) : raw;
    },
    set(value) {
      this.setDataValue('mfa_secret', value ? encrypt(value) : value);
    },
  },
  mfa_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Email vérifié (lien de confirmation envoyé à l'inscription) — module sécurité
  email_verifie: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Mot de passe temporaire imposé par un admin — doit être changé au 1er login
  mdp_temporaire: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // ── Protection anti force-brute (verrouillage du compte) ──
  tentatives_connexion: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  compte_bloque_jusqua: {
    type: DataTypes.DATE,
    allowNull: true,
  }
}, {
  tableName: 'utilisateur',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['role'] },
    { fields: ['statut'] },
    { fields: ['organisation_id'] }
  ]
});

module.exports = User;
