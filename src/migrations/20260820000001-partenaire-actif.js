'use strict';

/**
 * Migration : ajout de la colonne `actif` à la table `partenaires`.
 *
 * Désactivation RÉVERSIBLE d'un intervenant, symétrique du statut
 * actif/inactif des membres — à distinguer du soft delete `deleted_at`,
 * qui retire le partenaire de l'annuaire. Les lignes existantes sont
 * considérées actives (`defaultValue: true`), ce qui préserve le
 * comportement d'avant migration.
 *
 * Pas d'index dédié : le filtre porte toujours sur `organisation_id`
 * d'abord (index existant), et `actif` est un booléen quasi toujours vrai —
 * un index n'y apporterait rien de mesurable.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('partenaires');
    if (table.actif) return; // déjà appliquée

    await queryInterface.addColumn('partenaires', 'actif', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('partenaires', 'actif');
  },
};
