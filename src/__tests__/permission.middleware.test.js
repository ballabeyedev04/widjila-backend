'use strict';

/**
 * Tests — middlewares/permission.middleware.js (audit — Bugs & fiabilité §1).
 *
 * Modèle "deny by default" explicitement documenté dans le fichier source :
 * un compte sans permission définie doit être refusé, jamais laissé passer
 * implicitement. C'est exactement le genre de logique où une régression
 * silencieuse (ex: `perms.length === 0` remplacé par une condition inversée)
 * transforme un contrôle d'accès en trou de sécurité.
 */

const requirePermission = require('../middlewares/permission.middleware.js');

function run(user, permission) {
  const req = { user };
  const next = jest.fn();
  requirePermission(permission)(req, {}, next);
  return next;
}

describe('permission.middleware — requirePermission()', () => {
  test('refuse un compte sans permissions (undefined)', () => {
    const next = run({}, 'chantiers.creer');
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/aucune permission/i);
  });

  test('refuse un compte avec permissions = []', () => {
    const next = run({ permissions: [] }, 'chantiers.creer');
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
  });

  test('refuse un compte avec permissions = null', () => {
    const next = run({ permissions: null }, 'chantiers.creer');
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('refuse si permissions n\'est pas un tableau (ex: chaîne)', () => {
    const next = run({ permissions: 'all' }, 'chantiers.creer');
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('autorise si permissions contient exactement la permission demandée', () => {
    const next = run({ permissions: ['chantiers.creer', 'reserves.lire'] }, 'chantiers.creer');
    expect(next).toHaveBeenCalledWith(); // next() sans argument = laisser passer
  });

  test('refuse si permissions ne contient PAS la permission demandée', () => {
    const next = run({ permissions: ['reserves.lire'] }, 'chantiers.creer');
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('"all" autorise n\'importe quelle permission demandée', () => {
    const next = run({ permissions: ['all'] }, 'admin.tout.faire');
    expect(next).toHaveBeenCalledWith();
  });
});
