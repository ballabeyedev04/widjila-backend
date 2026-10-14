'use strict';

const { idempotent } = require('../utils/migrationIdempotente.js');

/**
 * Migration : `refresh_tokens.rotated_at` — détection de la réutilisation
 * d'un refresh token (audit sécurité SC-04).
 *
 * Un refresh token REMPLACÉ par une rotation ne doit plus jamais être
 * présenté. S'il l'est, quelqu'un d'autre que le client légitime le détient :
 * toute la famille de sessions du compte est alors coupée.
 *
 * Il faut pour cela distinguer deux sortes de jetons « révoqués » :
 *   - remplacés par une rotation (`rotated_at` renseigné) — leur rejeu est un
 *     signal de vol ;
 *   - révoqués volontairement (déconnexion, changement de mot de passe,
 *     désactivation…) — un vieil appareil qui les présente encore n'est PAS
 *     une attaque, et ne doit pas déconnecter la session courante.
 *
 * Colonne nullable, sans valeur par défaut : additive, sans réécriture des
 * lignes existantes (qui restent traitées comme « révocation volontaire »).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    queryInterface = idempotent(queryInterface);
    await queryInterface.addColumn('refresh_tokens', 'rotated_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('refresh_tokens', 'rotated_at');
  },
};
