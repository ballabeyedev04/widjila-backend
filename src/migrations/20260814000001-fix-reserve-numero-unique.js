'use strict';

/**
 * Migration : corrige la portée de l'unicité du numéro de réserve.
 *
 * Le service numérote les réserves PAR CHANTIER (`R-0001` repart à 1 sur chaque
 * chantier), mais la contrainte posée sur la colonne était GLOBALE. Résultat :
 * le second chantier d'une organisation ne pouvait jamais créer sa première
 * réserve — violation de contrainte unique, erreur 500.
 *
 * On remplace la contrainte de colonne par un index unique composite
 * (chantier_id, numero).
 *
 * Note : les noms de contraintes générés par Sequelize varient selon la façon
 * dont la table a été créée (sync ou migration). On tente donc plusieurs noms
 * connus et on ignore ceux qui n'existent pas.
 */

const CANDIDATS = [
  'reserves_numero_key',      // contrainte UNIQUE générée par Postgres
  'reserves_numero_unique',   // variante Sequelize
  'reserves_numero',          // index simple posé par l'ancien { fields: ['numero'] }
];

module.exports = {
  async up(queryInterface) {
    // 1. Retirer l'unicité globale, quelle que soit sa forme
    for (const nom of CANDIDATS) {
      try {
        await queryInterface.removeConstraint('reserves', nom);
      } catch {
        /* la contrainte n'existe pas sous ce nom — on continue */
      }
    }
    for (const nom of CANDIDATS) {
      try {
        await queryInterface.removeIndex('reserves', nom);
      } catch {
        /* l'index n'existe pas sous ce nom — on continue */
      }
    }

    // 2. Poser l'unicité composite — déjà présente sur une base neuve (créée
    // par 20260809000000 d'après la forme actuelle du modèle) ; l'erreur est
    // alors avalée. Code SQLSTATE plutôt que texte du message : un serveur
    // Postgres en locale française ne renvoie jamais "already exists" (testé
    // en conditions réelles).
    try {
      await queryInterface.addIndex('reserves', ['chantier_id', 'numero'], {
        name: 'reserves_chantier_numero_unique',
        unique: true,
      });
    } catch (err) {
      const code = err?.parent?.code || err?.original?.code;
      const dejaExistant = code === '42710' || /already exists|existe déjà/i.test(err.message || '');
      if (!dejaExistant) throw err;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('reserves', 'reserves_chantier_numero_unique');
    await queryInterface.changeColumn('reserves', 'numero', {
      type: Sequelize.STRING(20),
      allowNull: false,
      unique: true,
    });
  },
};
