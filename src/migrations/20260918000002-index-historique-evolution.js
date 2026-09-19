'use strict';

/**
 * Index — courbe d'évolution et délai de traitement du tableau de bord.
 *
 * `DashboardService.evolution` lit désormais les « traitées » et « levées »
 * dans `reserve_historiques` (WHERE action = ? AND created_at >= ?), et
 * `dureeTraitement` y cherche les actions `creation` / `validation`. La
 * table n'était indexée que sur `reserve_id` : chaque ouverture du tableau de
 * bord parcourait tout l'historique, qui grossit à chaque changement de
 * statut et n'est jamais purgé.
 *
 * Même règle et même mécanique que 20260912000001-perf-index-chemin-chaud.js
 * (CONCURRENTLY, reprise d'un index INVALID, table absente ignorée).
 */

const INDEX = [
  {
    nom: 'idx_reserve_historiques_action_created',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reserve_historiques_action_created '
      + 'ON reserve_historiques (action, created_at)',
  },
];

async function poser(queryInterface, { nom, sql }) {
  const [[invalide]] = await queryInterface.sequelize.query(
    `SELECT 1 AS present FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = :nom AND NOT i.indisvalid`,
    { replacements: { nom } }
  );
  if (invalide) await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
  await queryInterface.sequelize.query(sql);
}

module.exports = {
  INDEX,

  async up(queryInterface) {
    const tables = new Set(await queryInterface.showAllTables());
    for (const index of INDEX) {
      const table = / ON ([a-z_]+) /.exec(index.sql)[1];
      if (!tables.has(table)) continue;
      try {
        await poser(queryInterface, index);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[index] ${index.nom} non posé : ${err.message}`);
      }
    }
  },

  async down(queryInterface) {
    for (const { nom } of INDEX) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
    }
  },
};
