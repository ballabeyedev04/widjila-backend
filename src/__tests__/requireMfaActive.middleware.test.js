'use strict';

/**
 * Tests — middlewares/requireMfaActive.middleware.js
 *
 * Le MFA du super-admin est désormais une OPTION : il n'est exigé que si
 * `MFA_ADMIN_OBLIGATOIRE=true` (voir config/security.js). Les deux régimes
 * sont testés, car les deux sont livrés :
 *
 *  - drapeau baissé (défaut) : le garde est transparent pour tout le monde ;
 *  - drapeau levé : on retrouve la règle de l'audit Sécurité §3 — le rôle
 *    'Admin' traverse `checkOrganisation` sans filtre, une régression ici
 *    rouvrirait l'accès à toutes les organisations clientes sans MFA.
 *
 * `jest.resetModules()` avant chaque chargement : `mfaConfig` fige la valeur
 * de la variable d'environnement au premier `require`, un module déjà en
 * cache garderait le régime du test précédent.
 */

function chargerGarde({ obligatoire }) {
  jest.resetModules();
  if (obligatoire) {
    process.env.MFA_ADMIN_OBLIGATOIRE = 'true';
  } else {
    delete process.env.MFA_ADMIN_OBLIGATOIRE;
  }
  return require('../middlewares/requireMfaActive.middleware.js');
}

function run(garde, user) {
  const next = jest.fn();
  garde({ user }, {}, next);
  return next;
}

describe('requireMfaActive.middleware — MFA optionnel (défaut)', () => {
  let garde;
  beforeEach(() => {
    garde = chargerGarde({ obligatoire: false });
  });

  test('laisse passer un Admin SANS MFA', () => {
    expect(run(garde, { role: 'Admin', mfa_active: false })).toHaveBeenCalledWith();
  });

  test('laisse passer un Admin dont mfa_active est undefined', () => {
    expect(run(garde, { role: 'Admin' })).toHaveBeenCalledWith();
  });

  test('laisse passer un Admin avec MFA active', () => {
    expect(run(garde, { role: 'Admin', mfa_active: true })).toHaveBeenCalledWith();
  });

  test('laisse passer les rôles non-Admin', () => {
    expect(run(garde, { role: 'ChefProjet', mfa_active: false })).toHaveBeenCalledWith();
  });
});

describe('requireMfaActive.middleware — MFA exigé (MFA_ADMIN_OBLIGATOIRE=true)', () => {
  let garde;
  beforeEach(() => {
    garde = chargerGarde({ obligatoire: true });
  });

  test('laisse passer un rôle non-Admin, MFA active ou non', () => {
    expect(run(garde, { role: 'ChefProjet', mfa_active: false })).toHaveBeenCalledWith();
    expect(run(garde, { role: 'ConducteurTravaux' })).toHaveBeenCalledWith();
  });

  test('refuse un Admin sans MFA active', () => {
    const next = run(garde, { role: 'Admin', mfa_active: false });
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/authentification à deux facteurs/i);
  });

  test('refuse un Admin dont mfa_active est undefined (compte jamais configuré)', () => {
    const next = run(garde, { role: 'Admin' });
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('laisse passer un Admin avec MFA active', () => {
    expect(run(garde, { role: 'Admin', mfa_active: true })).toHaveBeenCalledWith();
  });
});
