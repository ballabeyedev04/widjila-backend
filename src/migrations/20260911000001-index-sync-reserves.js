'use strict';

/**
 * Index du tirage incrémental des réserves (`GET /sync/reserves`, audit
 * synchronisation).
 *
 * Le tirage filtre et trie sur l'expression
 * `GREATEST(updated_at, COALESCE(deleted_at, updated_at))` puis sur `id` —
 * voir `modules/sync/service/sync.service.js`. Sans index sur cette EXPRESSION
 * (un index sur `updated_at` seul ne sert pas), chaque page relit toute la
 * table des réserves.
 *
 * `IF NOT EXISTS` / `IF EXISTS` : rejouable sans erreur.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS reserves_marque_sync_idx '
      + 'ON reserves ((GREATEST(updated_at, COALESCE(deleted_at, updated_at))), id)',
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS reserves_marque_sync_idx');
  },
};
