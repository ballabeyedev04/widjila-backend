'use strict';

/**
 * Tests — middlewares/pagination.middleware.js (audit — Bugs & fiabilité §1).
 *
 * C'est le garde-fou anti-DoS documenté dans le fichier lui-même : sans lui,
 * `?limit=500000` dumpait une table entière en une requête. Aucune régression
 * ne doit pouvoir désactiver silencieusement ce plafonnement.
 */

const paginate = require('../middlewares/pagination.middleware.js');

function mockReq(query) {
  return { query };
}

function callMiddleware(middleware, query) {
  const req = mockReq(query);
  const next = jest.fn();
  middleware(req, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req;
}

describe('pagination.middleware — entierBorne / paginate()', () => {
  const middleware = paginate();

  test('valeurs par défaut sans query string', () => {
    const req = callMiddleware(middleware, {});
    expect(req.pagination).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  test('plafonne une limite excessive à LIMITE_MAX (100)', () => {
    const req = callMiddleware(middleware, { limit: '500000' });
    expect(req.pagination.limit).toBe(paginate.LIMITE_MAX);
    expect(req.query.limit).toBe(paginate.LIMITE_MAX);
  });

  test('plafonne une page excessive à PAGE_MAX', () => {
    const req = callMiddleware(middleware, { page: '1e9' });
    expect(req.pagination.page).toBe(paginate.PAGE_MAX);
  });

  test('rejette les valeurs non numériques → repli sur le défaut', () => {
    const req = callMiddleware(middleware, { limit: 'DROP TABLE utilisateur;' });
    expect(req.pagination.limit).toBe(paginate.LIMITE_DEFAUT);
  });

  test('rejette les valeurs négatives ou flottantes', () => {
    const reqNeg = callMiddleware(middleware, { page: '-5' });
    expect(reqNeg.pagination.page).toBe(1);

    const reqFloat = callMiddleware(middleware, { limit: '10.9' });
    expect(reqFloat.pagination.limit).toBe(10);
  });

  test('tolère un paramètre répété (?limit=1&limit=2) — garde la dernière valeur', () => {
    const req = callMiddleware(middleware, { limit: ['1', '2'] });
    expect(req.pagination.limit).toBe(2);
  });

  test('offset calculé correctement pour page > 1', () => {
    const req = callMiddleware(middleware, { page: '3', limit: '10' });
    expect(req.pagination.offset).toBe(20);
  });

  test('une route peut définir un plafond plus bas que LIMITE_MAX', () => {
    const middlewareRestreint = paginate({ max: 5, defaut: 2 });
    const req = callMiddleware(middlewareRestreint, { limit: '100' });
    expect(req.pagination.limit).toBe(5);
  });

  test('le plafond spécifique à une route ne peut jamais dépasser LIMITE_MAX', () => {
    const middlewareTropLarge = paginate({ max: 999999 });
    const req = callMiddleware(middlewareTropLarge, { limit: '999999' });
    expect(req.pagination.limit).toBe(paginate.LIMITE_MAX);
  });
});
