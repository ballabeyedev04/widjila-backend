'use strict';

/**
 * Circuit de validation des chantiers.
 *
 * ── Ce que fait cette migration ───────────────────────────────────────────
 * 1. convertit `chantiers.statut` d'`ENUM` en `VARCHAR(30)`, pour accueillir
 *    `en_attente_validation` et `rejete` — et les suivants sans migration ;
 * 2. ajoute `demandeur_id`, `motif_rejet`, `valide_par_id` et `valide_le`.
 *
 * ── Pourquoi convertir la colonne ─────────────────────────────────────────
 * Ajouter une valeur à un ENUM PostgreSQL est possible (`ADD VALUE`) mais ne
 * se défait pas : le `down()` ne pourrait pas la retirer, et chaque statut
 * ajouté demanderait une livraison. La liste vit désormais dans
 * `config/enums.js`, appliquée par le modèle (`validate.isIn`).
 *
 * ── Ce que la migration NE fait PAS ───────────────────────────────────────
 * Elle ne touche à AUCUN chantier existant. `USING statut::text` recopie les
 * valeurs à l'identique : un chantier « en_cours » reste « en_cours ». Les
 * deux nouveaux statuts n'apparaissent que sur les chantiers créés APRÈS
 * cette livraison — aucun chantier en activité ne bascule en attente.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` remet l'ENUM d'origine et retire les colonnes. La conversion
 * ÉCHOUERA si des chantiers portent l'un des deux nouveaux statuts : c'est
 * voulu — mieux vaut un rollback qui refuse qu'un rollback qui écrase le
 * statut de demandes en cours.
 */

const { idempotent } = require('../utils/migrationIdempotente.js');

const ENUM_ORIGINE = ['en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture'];

module.exports = {
  async up(queryInterface, Sequelize) {
    // Base vierge : les colonnes existent déjà (créées d'après le modèle par
    // 20260809000000) — voir utils/migrationIdempotente.js.
    queryInterface = idempotent(queryInterface);
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `ALTER TABLE "chantiers"
           ALTER COLUMN "statut" TYPE VARCHAR(30) USING "statut"::text,
           ALTER COLUMN "statut" SET DEFAULT 'en_preparation'`,
        { transaction: t }
      );

      await queryInterface.addColumn('chantiers', 'demandeur_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        // Le compte parti, la demande reste lisible : elle porte l'historique
        // du chantier. `SET NULL` plutôt que `CASCADE`, qui supprimerait le
        // chantier lui-même.
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }, { transaction: t });

      await queryInterface.addColumn('chantiers', 'motif_rejet', {
        type: Sequelize.TEXT,
        allowNull: true,
      }, { transaction: t });

      await queryInterface.addColumn('chantiers', 'valide_par_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }, { transaction: t });

      await queryInterface.addColumn('chantiers', 'valide_le', {
        type: Sequelize.DATE,
        allowNull: true,
      }, { transaction: t });

      await queryInterface.addIndex('chantiers', ['demandeur_id'], {
        name: 'chantiers_demandeur_id',
        transaction: t,
      });

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeIndex('chantiers', 'chantiers_demandeur_id', { transaction: t });
      await queryInterface.removeColumn('chantiers', 'valide_le', { transaction: t });
      await queryInterface.removeColumn('chantiers', 'valide_par_id', { transaction: t });
      await queryInterface.removeColumn('chantiers', 'motif_rejet', { transaction: t });
      await queryInterface.removeColumn('chantiers', 'demandeur_id', { transaction: t });

      await queryInterface.changeColumn('chantiers', 'statut', {
        type: Sequelize.ENUM(...ENUM_ORIGINE),
        allowNull: false,
        defaultValue: 'en_preparation',
      }, { transaction: t });

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },
};
