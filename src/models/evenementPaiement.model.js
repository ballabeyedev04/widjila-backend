const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Événement de paiement reçu par webhook — le journal qui rend le traitement
 * IDEMPOTENT.
 *
 * ── Le problème qu'il résout ──────────────────────────────────────────────
 * Stripe RÉÉMET un webhook tant qu'il n'a pas reçu un 2xx : coupure réseau,
 * redémarrage du serveur, délai dépassé, et le même
 * `payment_intent.succeeded` arrive deux ou trois fois. Sans trace, chaque
 * réception rejouait l'activation — prolongeant l'abonnement, réécrivant des
 * dates, créant des lignes d'historique en double.
 *
 * L'index unique sur (`fournisseur`, `evenement_id`) est le verrou : la
 * seconde insertion échoue, et le service en déduit « déjà traité » sans
 * avoir eu à raisonner sur l'état métier.
 *
 * On enregistre AVANT de traiter, pas après : si le traitement échoue à
 * mi-chemin, la ligne existe déjà et `traite_le` reste nul — on sait donc
 * distinguer « jamais vu » de « vu mais non abouti ».
 */
const EvenementPaiement = sequelize.define('EvenementPaiement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  fournisseur: {
    type: DataTypes.ENUM('stripe', 'paytech'),
    allowNull: false
  },
  // Identifiant de l'événement CHEZ LE FOURNISSEUR (`evt_...` pour Stripe).
  evenement_id: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  type: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  // Nul tant que le traitement n'a pas abouti — voir l'en-tête.
  traite_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Message d'erreur du dernier traitement échoué, pour le diagnostic.
  erreur: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  organisationId: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'evenements_paiement',
  timestamps: true,
  underscored: true,
  indexes: [
    // LE verrou d'idempotence.
    { unique: true, fields: ['fournisseur', 'evenement_id'] },
    { fields: ['organisation_id'] }
  ]
});

module.exports = EvenementPaiement;
