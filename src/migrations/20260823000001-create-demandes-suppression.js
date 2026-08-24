'use strict';

/**
 * Migration : table `demandes_suppression`.
 *
 * Alimente la page publique `/suppression-compte`, exigée par Google Play
 * (URL de demande de suppression accessible sans connexion) et par le RGPD
 * (art. 17, réponse sous 30 jours).
 *
 * AUCUNE clé étrangère vers `utilisateurs`, volontairement : le demandeur
 * n'est pas authentifié et peut n'avoir jamais eu de compte sous l'adresse
 * qu'il déclare. Une contrainte référentielle rejetterait la demande au lieu
 * de l'enregistrer, et on perdrait la trace d'une sollicitation à laquelle la
 * loi impose de répondre. Le rapprochement est fait à la main par l'admin,
 * après vérification d'identité.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotence — même garde que les autres migrations du projet.
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('demandes_suppression');
    if (existe) return;

    await queryInterface.createTable('demandes_suppression', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      email: {
        type: Sequelize.STRING(320), // RFC 5321
        allowNull: false,
      },
      objet: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      statut: {
        type: Sequelize.ENUM('en_attente', 'traitee', 'rejetee'),
        allowNull: false,
        defaultValue: 'en_attente',
      },
      // Nullable : derrière un proxy mal configuré l'IP peut manquer, ce qui
      // ne doit pas faire échouer l'enregistrement de la demande.
      ip: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      traite_par: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      traite_le: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      note_admin: {
        type: Sequelize.TEXT,
        allowNull: true,
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

    // La file de travail de l'admin : filtrée par statut, triée par date.
    await queryInterface.addIndex('demandes_suppression', ['statut', 'created_at'], {
      name: 'demandes_suppression_statut_created_at',
    });

    // Repérage des doublons pour une même adresse (anti-redépôt).
    await queryInterface.addIndex('demandes_suppression', ['email'], {
      name: 'demandes_suppression_email',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('demandes_suppression');
    // PostgreSQL conserve le type ENUM après le DROP TABLE : sans cette
    // ligne, rejouer la migration échouerait sur un type déjà existant.
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_demandes_suppression_statut";'
    );
  },
};
