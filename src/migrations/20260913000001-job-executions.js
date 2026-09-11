'use strict';

/**
 * Historique des exécutions des tâches planifiées — voir
 * `models/jobExecution.model.js` et `utils/executerJob.js`.
 *
 * Rejouable : sur une base de développement où `sync({ alter: true })` a déjà
 * créé la table d'après le modèle, la création est sautée.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const existe = tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes('job_executions');

    if (!existe) {
      await queryInterface.createTable('job_executions', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        job: { type: Sequelize.STRING(100), allowNull: false },
        statut: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'en_cours' },
        tentative: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        debut: { type: Sequelize.DATE, allowNull: false },
        fin: { type: Sequelize.DATE, allowNull: true },
        duree_ms: { type: Sequelize.INTEGER, allowNull: true },
        erreur: { type: Sequelize.TEXT, allowNull: true },
        resultat: { type: Sequelize.JSON, allowNull: true },
        instance: { type: Sequelize.STRING(120), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
    }

    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS job_executions_job_debut ON job_executions (job, debut)',
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS job_executions_statut ON job_executions (statut)',
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('job_executions');
  },
};
