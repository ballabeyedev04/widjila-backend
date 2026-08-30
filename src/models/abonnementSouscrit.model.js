const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Souscription — l'historique des abonnements d'une organisation.
 *
 * ── Pourquoi une table dédiée ─────────────────────────────────────────────
 * L'organisation ne portait qu'un état COURANT (`abonnement`, `is_subscribed`,
 * quelques identifiants Stripe). Rien ne disait ce qui avait été payé, quand,
 * ni à quel prix. Impossible d'expliquer une facture, de suivre un
 * renouvellement, ou même de savoir qu'une organisation a déjà été abonnée.
 *
 * ── Le prix payé est FIGÉ ici ─────────────────────────────────────────────
 * `prix_paye`, `plan_code` et `plan_nom` sont recopiés au moment de la
 * souscription, et ne bougent plus. Si l'administrateur passe demain Pro de
 * 89 € à 99 €, les souscriptions déjà encaissées continuent d'afficher 89 € —
 * ce qui est la seule lecture honnête d'une transaction passée.
 *
 * C'est aussi pourquoi `planAbonnementId` est en `SET NULL` : supprimer une
 * formule du catalogue ne doit pas effacer l'historique de ceux qui l'ont
 * payée.
 */
const AbonnementSouscrit = sequelize.define('AbonnementSouscrit', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // Peut devenir NULL si la formule est supprimée du catalogue — d'où la
  // recopie du code et du nom juste en dessous.
  planAbonnementId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // ── Instantané de la formule au moment de la souscription ────────────────
  plan_code: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  plan_nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  prix_paye: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  devise: {
    type: DataTypes.STRING(3),
    allowNull: false,
    defaultValue: 'EUR'
  },
  periode: {
    type: DataTypes.ENUM('mois', 'an'),
    allowNull: false,
    defaultValue: 'mois'
  },
  /**
   * Cycle de vie d'une souscription.
   *
   * `en_attente` : intention de paiement créée, rien n'est encore encaissé.
   *   L'abonnement n'est PAS actif — c'est ce statut qui empêche un client
   *   de s'attribuer une formule en abandonnant le paiement.
   * `active`     : paiement confirmé par le fournisseur (webhook).
   * `echec`      : paiement refusé.
   * `annulee`    : annulée par le client ou l'administrateur.
   * `expiree`    : `date_fin` dépassée sans renouvellement.
   */
  statut: {
    type: DataTypes.ENUM('en_attente', 'active', 'echec', 'annulee', 'expiree'),
    allowNull: false,
    defaultValue: 'en_attente'
  },
  date_debut: {
    type: DataTypes.DATE,
    allowNull: true
  },
  date_fin: {
    type: DataTypes.DATE,
    allowNull: true
  },
  /**
   * Fournisseur de paiement. `manuel` couvre les formules « sur devis »
   * activées par l'administrateur après négociation, hors parcours de carte.
   */
  fournisseur: {
    type: DataTypes.ENUM('stripe', 'paytech', 'manuel'),
    allowNull: false,
    defaultValue: 'stripe'
  },
  // Référence chez le fournisseur (PaymentIntent Stripe, token PayTech…).
  // Unique : c'est elle qui empêche qu'un même paiement crée deux souscriptions.
  reference_paiement: {
    type: DataTypes.STRING(255),
    allowNull: true,
    unique: true
  },
  stripe_customer_id: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  stripe_subscription_id: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Renseigné quand un administrateur active la formule à la main.
  activee_par: {
    type: DataTypes.UUID,
    allowNull: true
  },
  note: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'abonnements_souscrits',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['statut'] },
    { fields: ['organisation_id', 'statut'] },
    { unique: true, fields: ['reference_paiement'] }
  ]
});

module.exports = AbonnementSouscrit;
