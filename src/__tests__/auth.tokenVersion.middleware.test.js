'use strict';

/**
 * Tests — middlewares/auth.middleware.js, volet `token_version`.
 *
 * Ce qui est vérifié ici est précisément ce qui manquait : un token d'accès
 * JWT est sans état, donc rien ne pouvait l'annuler avant son expiration.
 * Révoquer les refresh tokens ne fermait que le renouvellement — un token
 * volé restait valable jusqu'à `JWT_EXPIRES_IN` APRÈS que la victime a changé
 * son mot de passe.
 */

jest.mock('../models/utilisateur.model.js', () => ({ findByPk: jest.fn() }));

const jwt = require('jsonwebtoken');
const User = require('../models/utilisateur.model.js');
const { jwtConfig } = require('../config/security.js');
const authMiddleware = require('../middlewares/auth.middleware.js');

function signer(charge) {
  return jwt.sign(charge, jwtConfig.secret, { expiresIn: '1h' });
}

function contexte(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const next = jest.fn();
  return { req, res: {}, next };
}

function utilisateur(overrides = {}) {
  return { id: 'user-1', statut: 'actif', token_version: 0, ...overrides };
}

describe('auth.middleware — token_version', () => {
  beforeEach(() => jest.clearAllMocks());

  test('accepte un token dont la version correspond', async () => {
    User.findByPk.mockResolvedValue(utilisateur({ token_version: 4 }));
    const { req, res, next } = contexte(signer({ id: 'user-1', tv: 4 }));

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
  });

  test('REJETTE un token signé avant un changement de mot de passe', async () => {
    // L'utilisateur est passé en version 5 ; le token de l'attaquant porte
    // encore la 4.
    User.findByPk.mockResolvedValue(utilisateur({ token_version: 5 }));
    const { req, res, next } = contexte(signer({ id: 'user-1', tv: 4 }));

    await authMiddleware(req, res, next);

    const erreur = next.mock.calls[0][0];
    expect(erreur).toBeDefined();
    expect(erreur.statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });

  test('un token SANS tv vaut la version 0 — pas de déconnexion générale au déploiement', async () => {
    User.findByPk.mockResolvedValue(utilisateur({ token_version: 0 }));
    const { req, res, next } = contexte(signer({ id: 'user-1' }));

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
  });

  test('un token SANS tv est rejeté dès que le compte a changé de version', async () => {
    User.findByPk.mockResolvedValue(utilisateur({ token_version: 1 }));
    const { req, res, next } = contexte(signer({ id: 'user-1' }));

    await authMiddleware(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });
});
