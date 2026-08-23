'use strict';

/**
 * Migration : ajout de `token_version` à la table `utilisateur`.
 *
 * Rend RÉVOCABLE un token d'accès JWT, qui est sans état par nature. Le
 * compteur est embarqué dans chaque token signé (`tv`) et comparé à sa valeur
 * en base par `auth.middleware` ; l'incrémenter — ce que font désormais le
 * changement et la réinitialisation de mot de passe — périme d'un coup tous
 * les tokens déjà émis.
 *
 * Les lignes existantes démarrent à 0, et le middleware traite un token sans
 * `tv` comme la version 0 : les sessions en cours au moment du déploiement
 * survivent jusqu'à leur expiration naturelle, sans déconnexion générale.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('utilisateur');
    if (table.token_version) return; // déjà appliquée

    await queryInterface.addColumn('utilisateur', 'token_version', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('utilisateur', 'token_version');
  },
};
