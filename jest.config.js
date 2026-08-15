'use strict';

/**
 * Configuration Jest (audit — Bugs & fiabilité §1 : "0 test" avant cette
 * suite). Portée volontairement ciblée sur les modules les plus critiques —
 * voir le commentaire en tête de chaque fichier de `src/__tests__/` pour le
 * "pourquoi" de chacun. Ne remplace pas des tests d'intégration avec une
 * vraie base PostgreSQL, mais couvre la logique métier pure et les points
 * d'accès aux données via des mocks Sequelize.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.js'],
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
};
