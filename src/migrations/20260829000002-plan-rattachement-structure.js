'use strict';

/**
 * Migration : `plans.batiment_id` et `plans.etage_id`.
 *
 * Le plan ne pouvait se rattacher qu'à une ZONE (l'appartement). Le parcours
 * du guide client en réclame trois autres :
 *   - le plan global du chantier (aucun rattachement) ;
 *   - le plan d'un bâtiment ;
 *   - le plan d'un étage ou d'un sous-sol.
 *
 * Faute de ces colonnes, un plan d'étage ne pouvait être déposé qu'en
 * inventant une zone fictive pour le porter — la navigation « bâtiment →
 * étages → appartements » devenait alors impossible à reconstituer.
 *
 * Additive et rétrocompatible : les deux colonnes sont NULLABLES et les plans
 * existants restent valides tels quels (zone renseignée, ou plan global).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('plans');

    if (!table.batiment_id) {
      await queryInterface.addColumn('plans', 'batiment_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'batiments', key: 'id' },
        onUpdate: 'CASCADE',
        // SET NULL et non CASCADE : supprimer un bâtiment ne doit pas
        // emporter le document. Le plan redevient un plan de chantier, et
        // reste consultable — les réserves posées dessus y pointent encore.
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('plans', ['batiment_id'], { name: 'plans_batiment_id' });
    }

    if (!table.etage_id) {
      await queryInterface.addColumn('plans', 'etage_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'etages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('plans', ['etage_id'], { name: 'plans_etage_id' });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('plans');
    if (table.etage_id) await queryInterface.removeColumn('plans', 'etage_id');
    if (table.batiment_id) await queryInterface.removeColumn('plans', 'batiment_id');
  },
};
