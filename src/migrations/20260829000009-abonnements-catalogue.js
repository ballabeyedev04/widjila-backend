'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Migration : catalogue des formules, historique des souscriptions, journal
 * des événements de paiement.
 *
 * Trois tables, une seule raison : le système d'abonnement n'existait qu'en
 * dur dans le code (objet `PLANS` du service), sans historique ni protection
 * contre les webhooks rejoués.
 *
 * ── Données du catalogue ──────────────────────────────────────────────────
 * Les prix, limites d'utilisateurs et fonctionnalités proviennent EXCLUSIVEMENT
 * des documents fournis par le client : la présentation commerciale
 * (49 €/2 utilisateurs, 89 €/5 utilisateurs, sur devis/illimité) et le visuel
 * des formules pour la répartition des fonctionnalités.
 *
 * `limite_chantiers` reste NULL partout — la présentation cite
 * « multi-chantiers » comme avantage Pro, sans jamais donner de nombre pour
 * Essentiel. Inventer un plafond serait facturer une limite que le client n'a
 * pas définie. À trancher avec lui.
 *
 * Entreprise a `prix = NULL` (« sur devis ») : la formule s'affiche mais n'est
 * pas souscriptible en ligne tant que l'administrateur n'y pose pas de montant.
 */

const CATALOGUE = [
  {
    code: 'essentiel',
    nom: 'Essentiel',
    description: 'Levé de réserves illimité, export PDF, support standard.',
    prix: 49,
    limite_utilisateurs: 2,
    fonctionnalites: ['reserves', 'mobile', 'stockage', 'support_prioritaire'],
    ordre: 10,
  },
  {
    code: 'pro',
    nom: 'Pro',
    description: 'Rapports avancés, multi-chantiers, plans annotables, support prioritaire.',
    prix: 89,
    limite_utilisateurs: 5,
    fonctionnalites: [
      'reserves', 'mobile', 'stockage', 'support_prioritaire',
      'suivi_equipe', 'rapports', 'annotations', 'api',
    ],
    ordre: 20,
  },
  {
    code: 'entreprise',
    nom: 'Entreprise',
    description: 'Intégrations API, gestion d’équipes, hébergement dédié, accompagnement premium.',
    prix: null, // sur devis
    limite_utilisateurs: null, // illimité
    fonctionnalites: [
      'reserves', 'mobile', 'stockage', 'support_prioritaire',
      'suivi_equipe', 'rapports', 'annotations', 'api',
    ],
    ordre: 30,
  },
];

/** Vrai si la table existe déjà — garde d'idempotence du projet. */
async function existe(queryInterface, nom) {
  const tables = await queryInterface.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes(nom);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. Catalogue des formules ─────────────────────────────────────────
    if (!(await existe(queryInterface, 'plans_abonnement'))) {
      await queryInterface.createTable('plans_abonnement', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
          allowNull: false,
        },
        code: { type: Sequelize.STRING(50), allowNull: false, unique: true },
        nom: { type: Sequelize.STRING(100), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        // NULL = sur devis.
        prix: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        devise: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
        periode: {
          type: Sequelize.ENUM('mois', 'an'),
          allowNull: false,
          defaultValue: 'mois',
        },
        // NULL = illimité, dans les deux cas.
        limite_utilisateurs: { type: Sequelize.INTEGER, allowNull: true },
        limite_chantiers: { type: Sequelize.INTEGER, allowNull: true },
        fonctionnalites: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        },
        stripe_price_id: { type: Sequelize.STRING(100), allowNull: true },
        actif: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ordre: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
      });

      await queryInterface.addIndex('plans_abonnement', ['actif'], { name: 'plans_abonnement_actif' });
    }

    // ── 1 bis. Graine du catalogue ────────────────────────────────────────
    //
    // Séparée de la création de table, et conditionnée au CONTENU et non à
    // l'existence : un échec survenant entre le `createTable` et l'insertion
    // laisserait sinon une table créée mais vide, que le garde d'idempotence
    // ci-dessus ferait ensuite sauter à chaque rejeu — catalogue vide, écran
    // d'abonnement sans aucune offre, et rien pour le signaler.
    //
    // Compte plutôt que `INSERT ... ON CONFLICT` : le catalogue est modifiable
    // par l'administrateur, et réinsérer des lignes qu'il aurait délibérément
    // supprimées lui rendrait un travail qu'il a défait.
    const [{ total }] = await queryInterface.sequelize.query(
      'SELECT COUNT(*)::int AS total FROM plans_abonnement',
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    if (total === 0) {
      const maintenant = new Date();
      await queryInterface.bulkInsert('plans_abonnement', CATALOGUE.map((p) => ({
        id: randomUUID(),
        code: p.code,
        nom: p.nom,
        description: p.description,
        prix: p.prix,
        devise: 'EUR',
        periode: 'mois',
        limite_utilisateurs: p.limite_utilisateurs,
        // Voir l'en-tête : aucun nombre n'est donné par le client.
        limite_chantiers: null,
        fonctionnalites: JSON.stringify(p.fonctionnalites),
        stripe_price_id: null,
        actif: true,
        ordre: p.ordre,
        created_at: maintenant,
        updated_at: maintenant,
        deleted_at: null,
      })));
    }

    // ── 2. Historique des souscriptions ───────────────────────────────────
    if (!(await existe(queryInterface, 'abonnements_souscrits'))) {
      await queryInterface.createTable('abonnements_souscrits', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
          allowNull: false,
        },
        organisation_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'organisations', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        // SET NULL : retirer une formule du catalogue ne doit pas effacer
        // l'historique de ceux qui l'ont payée — d'où la recopie du code et du
        // nom juste en dessous.
        plan_abonnement_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'plans_abonnement', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        plan_code: { type: Sequelize.STRING(50), allowNull: false },
        plan_nom: { type: Sequelize.STRING(100), allowNull: false },
        prix_paye: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
        devise: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
        periode: {
          type: Sequelize.ENUM('mois', 'an'),
          allowNull: false,
          defaultValue: 'mois',
        },
        statut: {
          type: Sequelize.ENUM('en_attente', 'active', 'echec', 'annulee', 'expiree'),
          allowNull: false,
          defaultValue: 'en_attente',
        },
        date_debut: { type: Sequelize.DATE, allowNull: true },
        date_fin: { type: Sequelize.DATE, allowNull: true },
        fournisseur: {
          type: Sequelize.ENUM('stripe', 'paytech', 'manuel'),
          allowNull: false,
          defaultValue: 'stripe',
        },
        // Unique : c'est elle qui empêche qu'un même paiement crée deux
        // souscriptions, webhook rejoué compris.
        reference_paiement: { type: Sequelize.STRING(255), allowNull: true, unique: true },
        stripe_customer_id: { type: Sequelize.STRING(100), allowNull: true },
        stripe_subscription_id: { type: Sequelize.STRING(100), allowNull: true },
        activee_par: { type: Sequelize.UUID, allowNull: true },
        note: { type: Sequelize.TEXT, allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });

      await queryInterface.addIndex('abonnements_souscrits', ['organisation_id'], {
        name: 'abonnements_souscrits_organisation',
      });
      // Lecture dominante : « la souscription ACTIVE de cette organisation ».
      await queryInterface.addIndex('abonnements_souscrits', ['organisation_id', 'statut'], {
        name: 'abonnements_souscrits_organisation_statut',
      });
    }

    // ── 3. Journal des événements de paiement (idempotence) ───────────────
    if (!(await existe(queryInterface, 'evenements_paiement'))) {
      await queryInterface.createTable('evenements_paiement', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
          allowNull: false,
        },
        fournisseur: {
          type: Sequelize.ENUM('stripe', 'paytech'),
          allowNull: false,
        },
        evenement_id: { type: Sequelize.STRING(255), allowNull: false },
        type: { type: Sequelize.STRING(100), allowNull: false },
        traite_le: { type: Sequelize.DATE, allowNull: true },
        erreur: { type: Sequelize.TEXT, allowNull: true },
        organisation_id: { type: Sequelize.UUID, allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });

      // LE verrou d'idempotence : la seconde insertion du même événement
      // échoue, et le service en déduit « déjà traité ».
      await queryInterface.addIndex('evenements_paiement', ['fournisseur', 'evenement_id'], {
        unique: true,
        name: 'evenements_paiement_unique',
      });
      await queryInterface.addIndex('evenements_paiement', ['organisation_id'], {
        name: 'evenements_paiement_organisation',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('evenements_paiement');
    await queryInterface.dropTable('abonnements_souscrits');
    await queryInterface.dropTable('plans_abonnement');

    // PostgreSQL conserve les types ENUM après un DROP TABLE : sans ces
    // lignes, rejouer la migration échouerait sur des types déjà existants.
    for (const type of [
      'enum_evenements_paiement_fournisseur',
      'enum_abonnements_souscrits_statut',
      'enum_abonnements_souscrits_fournisseur',
      'enum_abonnements_souscrits_periode',
      'enum_plans_abonnement_periode',
    ]) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
  },
};
