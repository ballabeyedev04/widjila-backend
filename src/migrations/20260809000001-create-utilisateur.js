'use strict';

/**
 * Migration initiale : table utilisateur.
 * En dev, server.js fait aussi sync({ alter: true }) — la migration sert
 * de référence reproductible en production (npm run migrate).
 *
 * Le schéma DOIT rester aligné sur src/models/utilisateur.model.js.
 *
 * Rendue idempotente (audit — Bugs & fiabilité §1, testé contre une base
 * vierge) : sur une base neuve, `20260809000000-create-remaining-tables-
 * and-indexes.js` (qui tourne juste avant) a déjà créé `utilisateur` — les
 * autres tables du projet la référencent par clé étrangère et ont donc
 * besoin qu'elle existe tôt. Sans cette garde, cette migration échouait sur
 * « relation "utilisateur" already exists ». Sur la base de production
 * existante (où elle a déjà tourné il y a longtemps), rien ne change :
 * SequelizeMeta l'a déjà enregistrée, elle ne se rejoue jamais.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if ((await queryInterface.showAllTables()).includes('utilisateur')) return;

    await queryInterface.createTable('utilisateur', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      // Multi-tenant : null pour le super-admin plateforme (rôle 'Admin')
      organisationId: { type: Sequelize.UUID, allowNull: true },
      nom: { type: Sequelize.STRING, allowNull: false },
      prenom: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      mot_de_passe: { type: Sequelize.STRING, allowNull: false },
      telephone: { type: Sequelize.STRING, allowNull: true, unique: true },
      photoProfil: { type: Sequelize.STRING(255), allowNull: true },
      fonction: { type: Sequelize.STRING(100), allowNull: true },
      role: {
        type: Sequelize.ENUM('Admin', 'ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise', 'Client', 'MaitreOuvrage', 'MaitreOeuvre'),
        allowNull: false,
        defaultValue: 'ConducteurTravaux',
      },
      statut: {
        type: Sequelize.ENUM('actif', 'inactif', 'en_attente_validation'),
        allowNull: false,
        defaultValue: 'actif',
      },
      permissions: { type: Sequelize.JSON, allowNull: true, defaultValue: null },
      langue: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'fr' },
      dernierConnexion: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
      deletedAt: { type: Sequelize.DATE, allowNull: true }, // paranoid (soft delete)
    });

    await queryInterface.addIndex('utilisateur', ['organisationId']);
    await queryInterface.addIndex('utilisateur', ['role']);
    await queryInterface.addIndex('utilisateur', ['statut']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('utilisateur');
  },
};
