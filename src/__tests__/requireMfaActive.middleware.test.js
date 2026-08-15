'use strict';

/**
 * Tests — middlewares/requireMfaActive.middleware.js (audit — Sécurité §3).
 *
 * Le rôle 'Admin' (super-admin plateforme) traverse `checkOrganisation` sans
 * filtre : une régression ici rouvrirait l'accès à toutes les organisations
 * clientes sans MFA.
 */

const requireMfaActive = require('../middlewares/requireMfaActive.middleware.js');

function run(user) {
  const req = { user };
  const next = jest.fn();
  requireMfaActive(req, {}, next);
  return next;
}

describe('requireMfaActive.middleware', () => {
  test('laisse passer un rôle non-Admin, MFA active ou non', () => {
    expect(run({ role: 'ChefProjet', mfa_active: false })).toHaveBeenCalledWith();
    expect(run({ role: 'ConducteurTravaux' })).toHaveBeenCalledWith();
  });

  test('refuse un Admin sans MFA active', () => {
    const next = run({ role: 'Admin', mfa_active: false });
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/authentification à deux facteurs/i);
  });

  test('refuse un Admin dont mfa_active est undefined (compte jamais configuré)', () => {
    const next = run({ role: 'Admin' });
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('laisse passer un Admin avec MFA active', () => {
    expect(run({ role: 'Admin', mfa_active: true })).toHaveBeenCalledWith();
  });
});
