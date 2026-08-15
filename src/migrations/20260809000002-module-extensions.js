'use strict';

/**
 * Migration « extensions modules 1-9 ».
 *
 * Ajoute les colonnes des nouvelles fonctionnalités sur les tables EXISTANTES
 * (les nouvelles tables sont créées automatiquement par sequelize.sync).
 * En dev, server.js applique aussi sync({ alter:true }).
 *
 * Tables concernées :
 *   - utilisateur  : MFA (mfa_secret, mfa_active) + anti force-brute
 *                    (tentatives_connexion, compte_bloque_jusqua)
 *   - organisations: hiérarchie filiales/agences (type, parent_id)
 *   - reserves     : catégorie + nouveau statut 'en_retard'
 *   - documents    : archivage (statut) + signature (signataire_id, signe_le)
 *   - medias       : photos d'inspection (inspection_id) ; reserve_id nullable
 *
 * Rendue idempotente (audit — Bugs & fiabilité §1, testé contre une base
 * vierge) : `20260809000000-create-remaining-tables-and-indexes.js` tourne
 * maintenant AVANT cette migration et crée les tables absentes d'après la
 * forme ACTUELLE des modèles — qui inclut déjà ces colonnes. Sur une base
 * vierge, elles existent donc déjà quand cette migration s'exécute ; sur la
 * base de production existante (où cette migration a déjà tourné il y a
 * longtemps), rien ne change. `addColonneSiAbsente` vérifie via
 * `describeTable` avant chaque ajout.
 */

/** Ajoute une colonne seulement si elle n'existe pas déjà. */
async function addColonneSiAbsente(queryInterface, table, colonne, definition) {
  const colonnes = await queryInterface.describeTable(table);
  if (colonnes[colonne]) return;
  await queryInterface.addColumn(table, colonne, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── utilisateur : MFA + verrouillage ───────────────────────────────────
    await addColonneSiAbsente(queryInterface, 'utilisateur', 'mfa_secret', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await addColonneSiAbsente(queryInterface, 'utilisateur', 'mfa_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColonneSiAbsente(queryInterface, 'utilisateur', 'tentatives_connexion', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColonneSiAbsente(queryInterface, 'utilisateur', 'compte_bloque_jusqua', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // ── organisations : type + parent (filiales / agences) ─────────────────
    await addColonneSiAbsente(queryInterface, 'organisations', 'type', {
      type: Sequelize.ENUM('entreprise', 'filiale', 'agence'),
      allowNull: false,
      defaultValue: 'entreprise',
    });
    await addColonneSiAbsente(queryInterface, 'organisations', 'parent_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });

    // ── reserves : catégorie + statut 'en_retard' ───────────────────────────
    await addColonneSiAbsente(queryInterface, 'reserves', 'categorie', {
      type: Sequelize.ENUM(
        'maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage',
        'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre'
      ),
      allowNull: true,
      defaultValue: 'autre',
    });

    // Extension de l'enum de statut (PostgreSQL) — déjà idempotent
    // (IF NOT EXISTS), mais n'a d'effet que si la valeur 'en_retard' manque
    // réellement à l'énum — sans risque à rejouer.
    await queryInterface.sequelize.query(
      "ALTER TYPE \"enum_reserves_statut\" ADD VALUE IF NOT EXISTS 'en_retard';"
    );

    // ── documents : archivage + signature ───────────────────────────────────
    await addColonneSiAbsente(queryInterface, 'documents', 'statut', {
      type: Sequelize.ENUM('actif', 'archive'),
      allowNull: false,
      defaultValue: 'actif',
    });
    await addColonneSiAbsente(queryInterface, 'documents', 'signataire_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await addColonneSiAbsente(queryInterface, 'documents', 'signe_le', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // ── medias : photos d'inspection ────────────────────────────────────────
    await addColonneSiAbsente(queryInterface, 'medias', 'inspection_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    // reserve_id devient nullable (un média peut être lié à une inspection)
    // — changeColumn est naturellement idempotent : le rejouer sur une
    // colonne déjà nullable ne fait rien de plus que réaffirmer sa forme.
    await queryInterface.changeColumn('medias', 'reserve_id', {
      type: Sequelize.UUID,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('medias', 'inspection_id');
    await queryInterface.removeColumn('documents', 'signe_le');
    await queryInterface.removeColumn('documents', 'signataire_id');
    await queryInterface.removeColumn('documents', 'statut');
    await queryInterface.removeColumn('reserves', 'categorie');
    await queryInterface.removeColumn('organisations', 'parent_id');
    await queryInterface.removeColumn('organisations', 'type');
    await queryInterface.removeColumn('utilisateur', 'compte_bloque_jusqua');
    await queryInterface.removeColumn('utilisateur', 'tentatives_connexion');
    await queryInterface.removeColumn('utilisateur', 'mfa_active');
    await queryInterface.removeColumn('utilisateur', 'mfa_secret');
  },
};
