'use strict';

/**
 * Migration : ajoute les champs d'abonnement Stripe à la table organisations.
 * - trial_ends_at : fin de la période d'essai gratuite (7 jours)
 * - is_subscribed : abonnement actif (paiement validé)
 * - stripe_customer_id : ID client Stripe
 * - stripe_subscription_id : ID abonnement Stripe
 * - stripe_price_id : ID du prix Stripe (plan choisi)
 *
 * Rendue idempotente (audit — Bugs & fiabilité §1, testé contre une base
 * vierge) : sur une base neuve, ces colonnes existent déjà — créées par
 * `20260809000000-create-remaining-tables-and-indexes.js`, qui construit
 * `organisations` d'après la forme ACTUELLE du modèle. Sur la production
 * existante, rien ne change : cette migration y a déjà tourné.
 */

async function addColonneSiAbsente(queryInterface, table, colonne, definition) {
  const colonnes = await queryInterface.describeTable(table);
  if (colonnes[colonne]) return;
  await queryInterface.addColumn(table, colonne, definition);
}

// Code SQLSTATE plutôt que texte du message : un serveur Postgres en locale
// française ne renvoie jamais "already exists" (testé en conditions
// réelles), un filtre uniquement anglais laisse l'exception remonter à tort.
async function addIndexSiAbsent(queryInterface, table, champs) {
  try {
    await queryInterface.addIndex(table, champs);
  } catch (err) {
    const code = err?.parent?.code || err?.original?.code;
    const dejaExistant = code === '42710' || /already exists|existe déjà/i.test(err.message || '');
    if (!dejaExistant) throw err;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColonneSiAbsente(queryInterface, 'organisations', 'trial_ends_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await addColonneSiAbsente(queryInterface, 'organisations', 'is_subscribed', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await addColonneSiAbsente(queryInterface, 'organisations', 'stripe_customer_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
      unique: true,
    });

    await addColonneSiAbsente(queryInterface, 'organisations', 'stripe_subscription_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
      unique: true,
    });

    await addColonneSiAbsente(queryInterface, 'organisations', 'stripe_price_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });

    // Index pour les requêtes de vérification d'abonnement
    await addIndexSiAbsent(queryInterface, 'organisations', ['is_subscribed']);
    await addIndexSiAbsent(queryInterface, 'organisations', ['trial_ends_at']);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('organisations', 'trial_ends_at');
    await queryInterface.removeColumn('organisations', 'is_subscribed');
    await queryInterface.removeColumn('organisations', 'stripe_customer_id');
    await queryInterface.removeColumn('organisations', 'stripe_subscription_id');
    await queryInterface.removeColumn('organisations', 'stripe_price_id');
  },
};
