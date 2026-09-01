'use strict';

/**
 * Tests — `GET /api/v1/referentiels/enums`.
 *
 * Cet endpoint est la source unique que le web et le mobile consomment à la
 * place de leurs copies manuelles. Ce qui doit être verrouillé :
 *
 *   1. il exige une SESSION — pas de route ouverte de plus sur l'API ;
 *   2. il renvoie la structure exacte attendue par les clients, sinon leurs
 *      filtres se vident sans la moindre erreur ;
 *   3. il reste en LECTURE SEULE : aucune écriture ne doit exister sur des
 *      valeurs qui sont des colonnes ENUM PostgreSQL.
 */

// `otplib` et `@scure/base` sont publiés en ESM pur, que la configuration Jest
// du projet ne transforme pas. Charger `app.js` les tire via
// auth.route → mfa.service, et le test échouerait sur un
// `SyntaxError: Unexpected token 'export'` sans rapport avec ce qu'il vérifie.
// Même neutralisation que dans `suppressionCompte.route.test.js`.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

// Limiteurs neutralisés : toutes les requêtes d'un test partent de la même IP.
// Les limiteurs restent actifs en production, couverts par
// `rateLimit.sharedStore.test.js`.
jest.mock('../middlewares/rateLimit.middleware.js', () => {
  const passe = (req, res, next) => next();
  return {
    authRateLimit: passe,
    sessionRateLimit: passe,
    mutationRateLimit: passe,
    adminRateLimit: passe,
    otpEmailRateLimit: passe,
    authenticatedRateLimit: passe,
  };
});

const request = require('supertest');
const app = require('../app.js');
const { VUE_PUBLIQUE } = require('../config/enums.js');

describe('GET /api/v1/referentiels/enums', () => {
  it('refuse un appel sans session', async () => {
    const res = await request(app).get('/api/v1/referentiels/enums');
    expect(res.status).toBe(401);
  });

  it('refuse un jeton invalide', async () => {
    const res = await request(app)
      .get('/api/v1/referentiels/enums')
      .set('Authorization', 'Bearer jeton-forge');
    expect(res.status).toBe(401);
  });
});

describe('écritures interdites', () => {
  // Les valeurs servies sont des colonnes ENUM : les modifier demande une
  // migration. Aucun verbe d'écriture ne doit répondre autre chose que 404.
  it.each(['post', 'put', 'patch', 'delete'])('%s /referentiels/enums → 404', async (verbe) => {
    const res = await request(app)[verbe]('/api/v1/referentiels/enums');
    expect(res.status).toBe(404);
  });
});

describe('structure servie', () => {
  it('expose chaque clé sous forme de tableau de codes non vide', () => {
    // Contrôle direct de la vue, sans session : c'est elle qui est sérialisée
    // dans la réponse, et c'est sa forme que les clients parsent.
    for (const [cle, valeurs] of Object.entries(VUE_PUBLIQUE)) {
      expect(Array.isArray(valeurs)).toBe(true);
      expect(valeurs.length).toBeGreaterThan(0);
      valeurs.forEach((v) => {
        expect(typeof v).toBe('string');
        // Codes bruts, jamais des libellés traduits : la traduction vit côté
        // client pour suivre la langue de l'utilisateur.
        expect(v).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      });
      expect(new Set(valeurs).size).toBe(valeurs.length, `doublon dans ${cle}`);
    }
  });
});
