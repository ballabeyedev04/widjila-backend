'use strict';

/**
 * Migration : `reserves.corps_etat_id`, et reprise des catégories existantes.
 *
 * La catégorie d'une réserve vivait dans l'ENUM `reserves.categorie`. Elle
 * pointe désormais vers le catalogue `corps_etat`, administrable sans
 * déploiement.
 *
 * LA COLONNE `categorie` EST CONSERVÉE, volontairement :
 *   - un client mobile non mis à jour continue de l'envoyer et de la lire ;
 *   - l'export Excel des réserves s'appuie dessus (`reserveExcel.service.js`) ;
 *   - la supprimer ferait perdre l'information des réserves dont la catégorie
 *     ne correspond à aucune ligne du catalogue.
 * Les deux coexistent donc : `corps_etat_id` fait foi quand il est renseigné,
 * `categorie` reste le repli.
 *
 * LA REPRISE se fait par le CODE : les vingt-cinq lignes du catalogue standard
 * portent les dix codes de l'ancien ENUM à l'identique (voir la migration
 * précédente), le rapprochement est donc exact et non interprété.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('reserves');

    if (!table.corps_etat_id) {
      await queryInterface.addColumn('reserves', 'corps_etat_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'corps_etat', key: 'id' },
        onUpdate: 'CASCADE',
        // SET NULL et non CASCADE : retirer un corps d'état du catalogue ne
        // doit jamais effacer les réserves qui s'y rattachaient. Elles
        // retombent sur leur `categorie`, qui n'a pas bougé.
        onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('reserves', ['corps_etat_id'], {
        name: 'reserves_corps_etat_id',
      });
    }

    // Reprise — uniquement les réserves pas encore rattachées, pour que
    // rejouer la migration soit sans effet.
    await queryInterface.sequelize.query(`
      UPDATE reserves r
         SET corps_etat_id = c.id
        FROM corps_etat c
       WHERE c.organisation_id IS NULL
         AND c.code = r.categorie::text
         AND r.corps_etat_id IS NULL;
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('reserves');
    if (table.corps_etat_id) await queryInterface.removeColumn('reserves', 'corps_etat_id');
  },
};
