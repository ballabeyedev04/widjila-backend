const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

// Durée de l'essai gratuit offert à toute nouvelle organisation (cf. message
// de checkSubscription.middleware.js : « votre période d'essai de 7 jours »).
const TRIAL_JOURS = 7;

/**
 * Organisation — une entreprise cliente de la plateforme (multi-tenant).
 * Chaque organisation possède ses utilisateurs et ses chantiers.
 */
const Organisation = sequelize.define('Organisation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  nom: {
    type: DataTypes.STRING,
    allowNull: false
  },
  // Raison sociale (peut différer du nom commercial)
  raison_sociale: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  siret: {
    type: DataTypes.STRING(50),
    allowNull: true,
    unique: true
  },
  num_tva: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  rccm: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  ninea: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  telephone: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  adresse: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  ville: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  pays: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'France'
  },
  logo_url: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  // Abonnement SaaS (Starter, Pro, Business, Enterprise)
  abonnement: {
    type: DataTypes.STRING(50),
    allowNull: true,
    defaultValue: 'Starter'
  },
  // Trial gratuit de 7 jours.
  //
  // CORRECTIF (audit § 7) — `trial_ends_at` NULL = ACCÈS GRATUIT PERMANENT.
  // checkSubscription calcule `trialEnded = trial_ends_at && …` : une valeur
  // NULL est falsy, donc `trialEnded` vaut false et l'accès est accordé
  // indéfiniment. Or seul `register` positionnait ce champ — toute organisation
  // créée par creerFiliale, creerAgence ou par l'admin plateforme naissait avec
  // NULL, donc sans aucune limite d'essai.
  // Le défaut (JS + défaut SQL posé par la migration) garantit désormais que
  // TOUTE organisation naît avec un essai borné, quel que soit le chemin de
  // création — y compris un INSERT hors ORM.
  // `allowNull` reste à true : la colonne existante contient des NULL tant que
  // la migration 20260814000002 n'est pas passée, et un NOT NULL posé par
  // sync({ alter: true }) échouerait au démarrage en dev.
  trial_ends_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: () => new Date(Date.now() + TRIAL_JOURS * 24 * 60 * 60 * 1000),
  },
  // Abonnement actif (paiement Stripe validé)
  is_subscribed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Identifiants Stripe
  stripe_customer_id: {
    type: DataTypes.STRING(100),
    allowNull: true,
    unique: true,
  },
  stripe_subscription_id: {
    type: DataTypes.STRING(100),
    allowNull: true,
    unique: true,
  },
  stripe_price_id: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  // ── Hiérarchie d'organisation (module 2 / filiales & agences) ──
  type: {
    type: DataTypes.ENUM('entreprise', 'filiale', 'agence'),
    allowNull: false,
    defaultValue: 'entreprise'
  },
  // parent_id : filiale → entreprise mère ; agence → filiale
  parent_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  statut: {
    type: DataTypes.ENUM('actif', 'inactif'),
    allowNull: false,
    defaultValue: 'actif'
  }
}, {
  tableName: 'organisations',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['statut'] }
  ]
});

module.exports = Organisation;
