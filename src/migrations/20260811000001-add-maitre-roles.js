'use strict';

/**
 * Migration : ajout des rôles "MaitreOuvrage" et "MaitreOeuvre" à l'ENUM role.
 * Aligne la table utilisateur sur le modèle utilisateur.model.js et les
 * validations common.js (ROLE_UTILISATEUR).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // PostgreSQL : ALTER TYPE pour ajouter des valeurs à l'ENUM
    await queryInterface.sequelize.query(
      "ALTER TYPE \"enum_utilisateur_role\" ADD VALUE IF NOT EXISTS 'MaitreOuvrage';"
    );
    await queryInterface.sequelize.query(
      "ALTER TYPE \"enum_utilisateur_role\" ADD VALUE IF NOT EXISTS 'MaitreOeuvre';"
    );
  },

  async down(queryInterface, Sequelize) {
    // Note : PostgreSQL ne permet pas de supprimer des valeurs d'un ENUM facilement.
    // En cas de rollback, il faut recréer le type sans ces valeurs.
    // Cette migration est considérée comme irréversible en production.
    console.warn('Rollback non supporté pour ALTER TYPE ENUM (PostgreSQL).');
  },
};