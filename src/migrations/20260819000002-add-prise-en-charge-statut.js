'use strict';

/**
 * Migration : ajout du statut "prise_en_charge" à l'ENUM statut des réserves.
 * Étape intermédiaire entre "affectee" et "en_cours" — le sous-traitant
 * accuse réception d'une réserve avant de démarrer le travail. Aligne la
 * table reserves sur reserve.model.js et validations common.js
 * (STATUT_RESERVE).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      "ALTER TYPE \"enum_reserves_statut\" ADD VALUE IF NOT EXISTS 'prise_en_charge';"
    );
  },

  async down(queryInterface, Sequelize) {
    // PostgreSQL ne permet pas de supprimer des valeurs d'un ENUM facilement.
    console.warn('Rollback non supporté pour ALTER TYPE ENUM (PostgreSQL).');
  },
};
