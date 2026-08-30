const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Formule d'abonnement — Essentiel, Pro, Entreprise.
 *
 * ⚠️ À NE PAS CONFONDRE avec le modèle `Plan` (plans de chantier, PDF/DWG).
 * Le nom de table est `plans_abonnement` pour lever toute ambiguïté.
 *
 * ── Pourquoi une table plutôt qu'une constante ────────────────────────────
 * Les formules vivaient dans un objet figé du service (`PLANS`), avec leurs
 * prix. Changer un tarif imposait une livraison backend, et l'administrateur
 * n'avait aucun moyen d'agir. Elles sont désormais en base et administrables.
 *
 * ── Le prix affiché ne fait jamais foi ────────────────────────────────────
 * `prix` est la SEULE source du montant facturé : le client n'envoie qu'un
 * identifiant de formule, le serveur relit le prix ici. Un prix modifié dans
 * le navigateur n'a donc aucun effet.
 *
 * `prix = NULL` signifie « sur devis » : la formule est présentée mais NON
 * souscriptible en ligne (cas d'Entreprise). Dès que l'administrateur y pose
 * un montant, elle devient payable par carte comme les autres.
 *
 * ── Limites nulles ────────────────────────────────────────────────────────
 * `NULL` = illimité, pour `limite_utilisateurs` comme pour `limite_chantiers`.
 * On ne code pas `-1` : une colonne nullable dit « pas de limite » sans
 * qu'aucun calcul n'ait à connaître une sentinelle.
 */
const PlanAbonnement = sequelize.define('PlanAbonnement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  /**
   * Clé technique stable (`essentiel`, `pro`, `entreprise`).
   *
   * C'est elle que le code référence, jamais le nom affiché : renommer
   * « Pro » en « Professionnel » ne doit casser ni les droits, ni
   * l'historique, ni les rapprochements Stripe.
   */
  code: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // NULL = sur devis (voir l'en-tête). Décimal et non flottant : un prix ne
  // se calcule pas en binaire.
  prix: {
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
  // NULL = illimité.
  limite_utilisateurs: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  limite_chantiers: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  /**
   * Codes des fonctionnalités ouvertes par la formule.
   *
   * Un tableau plutôt qu'une colonne par fonctionnalité : la liste évolue au
   * gré du commercial, et chaque ajout demanderait sinon une migration. Les
   * codes reconnus sont énumérés dans `config/fonctionnalites.js` — une valeur
   * inconnue n'ouvre rien, elle ne casse rien.
   */
  fonctionnalites: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: []
  },
  /**
   * Price ID Stripe correspondant, pour un abonnement récurrent.
   * Facultatif : le paiement à l'unité n'en a pas besoin, il facture `prix`.
   */
  stripe_price_id: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Une formule retirée du catalogue est DÉSACTIVÉE, pas supprimée : les
  // souscriptions passées gardent leur référence et leur historique.
  actif: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  }
}, {
  tableName: 'plans_abonnement',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['code'] },
    { fields: ['actif'] }
  ]
});

module.exports = PlanAbonnement;
