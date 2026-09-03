'use strict';

/**
 * Table `chantier_membres` — affectation d'un utilisateur à un chantier.
 *
 * ── Pourquoi elle manquait, et ce que ça cassait ──────────────────────────
 * Le modèle `chantierMembre.model.js` existait depuis le début, mais AUCUNE
 * migration ne créait la table. En développement, `sequelize.sync({alter})`
 * la fabriquait au démarrage et personne ne s'en apercevait. En production,
 * `server.js` ne synchronise pas — les migrations y sont la seule source de
 * vérité du schéma — donc la table n'a jamais existé.
 *
 * Or `ChantierService._filtreCloisonnement` interroge cette table en SQL brut
 * pour tout rôle HORS gestion :
 *
 *     id IN (SELECT chantier_id FROM chantier_membres WHERE utilisateur_id = …)
 *
 * PostgreSQL rejetait donc la requête entière (« relation does not exist ») :
 * `listChantiers` échouait, et une entreprise ne pouvait afficher AUCUN
 * chantier. Un chef de projet, lui, ne déclenche pas ce filtre — d'où un
 * défaut qui ne se voyait que sur certains comptes, et jamais en
 * développement.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` supprime la table. Les affectations sont reconstructibles (elles
 * se recréent à la validation d'un chantier), aucune donnée métier
 * irremplaçable n'y vit.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    // Idempotence : en développement `sync({alter})` a pu créer la table avant
    // que cette migration n'existe. La recréer échouerait sur « already
    // exists » et bloquerait toute la file de migrations.
    if (tables.map((t) => String(t).toLowerCase()).includes('chantier_membres')) return;

    await queryInterface.createTable('chantier_membres', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      chantier_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'chantiers', key: 'id' },
        // L'affectation n'a plus d'objet sans son chantier.
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // Rôle porté SUR CE CHANTIER, distinct du rôle dans l'organisation :
      // « responsable », « intervenant »… Facultatif.
      role_chantier: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // Unicité : un utilisateur n'est affecté qu'une fois au même chantier.
    // C'est aussi ce qui rend l'affectation à la validation rejouable sans
    // produire de doublon.
    await queryInterface.addIndex('chantier_membres', ['chantier_id', 'utilisateur_id'], {
      unique: true,
      name: 'chantier_membres_chantier_utilisateur_unique',
    });

    // La sous-requête du cloisonnement filtre sur `utilisateur_id` seul : sans
    // cet index, elle balaierait la table à chaque liste de chantiers.
    await queryInterface.addIndex('chantier_membres', ['utilisateur_id'], {
      name: 'chantier_membres_utilisateur_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('chantier_membres');
  },
};
