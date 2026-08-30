'use strict';

/**
 * Migration : table `plan_hotspots`.
 *
 * Zones cliquables posées sur un plan, qui rendent navigable le parcours du
 * guide client : plan global → bâtiment → étage → appartement. Voir
 * `src/models/planHotspot.model.js` pour la convention de coordonnées
 * (pourcentages 0-100 de la page, jamais des pixels).
 *
 * PAS de clé étrangère sur `cible_id` : l'association est polymorphe
 * (`cible_type` vaut 'batiment', 'etage' ou 'zone'). PostgreSQL ne sait pas
 * contraindre une référence dont la table dépend d'une colonne voisine ; le
 * nettoyage des hotspots devenus orphelins est fait explicitement à la
 * suppression de la structure (chantier.service.js).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotence — même garde que les autres migrations du projet.
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('plan_hotspots');
    if (existe) return;

    await queryInterface.createTable('plan_hotspots', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      plan_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cible_type: {
        type: Sequelize.ENUM('batiment', 'etage', 'zone'),
        allowNull: false,
      },
      cible_id: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      libelle: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      x: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      y: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      largeur: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      hauteur: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      page: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Lecture dominante : « tous les hotspots de CE plan », à chaque
    // affichage d'un plan navigable.
    await queryInterface.addIndex('plan_hotspots', ['plan_id'], {
      name: 'plan_hotspots_plan_id',
    });

    // Nettoyage des orphelins à la suppression d'un bâtiment/étage/zone.
    await queryInterface.addIndex('plan_hotspots', ['cible_type', 'cible_id'], {
      name: 'plan_hotspots_cible',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('plan_hotspots');
    // PostgreSQL conserve le type ENUM après le DROP TABLE : sans cette
    // ligne, rejouer la migration échouerait sur un type déjà existant.
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_plan_hotspots_cible_type";'
    );
  },
};
