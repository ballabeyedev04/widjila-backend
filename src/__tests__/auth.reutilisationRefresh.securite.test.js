'use strict';

/**
 * Sécurité — rejeu d'un refresh token déjà remplacé (audit SC-04).
 *
 * Avant : présenter un refresh token révoqué répondait seulement « révoqué ».
 * Un voleur qui avait fait la rotation le premier gardait sa propre chaîne de
 * jetons indéfiniment ; la victime, renvoyée à la connexion, ne lui coupait
 * rien.
 *
 * Désormais, le rejeu d'un jeton REMPLACÉ (`rotatedAt`) au-delà de la fenêtre
 * de course coupe toutes les sessions du compte. Les révocations volontaires
 * (déconnexion, changement de mot de passe) et les courses entre deux
 * requêtes légitimes ne déclenchent rien.
 */

jest.mock('../models/index.js', () => ({
  RefreshToken: { findOne: jest.fn(), update: jest.fn(), create: jest.fn(), destroy: jest.fn(), count: jest.fn(), findAll: jest.fn() },
  Utilisateur: { findByPk: jest.fn(), increment: jest.fn() },
  MfaChallenge: {},
  Organisation: {},
}));
jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({ journaliserConnexion: jest.fn() }));

const jwt = require('jsonwebtoken');
const { RefreshToken, Utilisateur } = require('../models/index.js');
const sequelize = require('../config/db.js');
const { jwtConfig } = require('../config/security.js');
const AuthService = require('../modules/auth/service/auth.service.js');

const jeton = () => jwt.sign({ id: 'u-1', type: 'refresh', jti: String(Math.random()) }, jwtConfig.refreshSecret, { expiresIn: '7d' });
const ilYa = (ms) => new Date(Date.now() - ms);

beforeEach(() => {
  jest.clearAllMocks();
  RefreshToken.update.mockResolvedValue([1]);
  Utilisateur.increment.mockResolvedValue(undefined);
});

/** Révocation de TOUTE la famille : update sans tokenHash, filtré par utilisateur. */
const familleRevoquee = () => RefreshToken.update.mock.calls.some(
  ([valeurs, { where }]) => valeurs.revoked === true && where.utilisateurId === 'u-1' && !where.tokenHash,
);

describe('AuthService.refresh — détection de la réutilisation', () => {
  test('jeton remplacé il y a 10 min et rejoué : toutes les sessions sont coupées', async () => {
    RefreshToken.findOne.mockResolvedValue({ utilisateurId: 'u-1', revoked: true, rotatedAt: ilYa(10 * 60_000), expiresAt: new Date(Date.now() + 1e9) });

    const r = await AuthService.refresh({ refreshToken: jeton() });

    expect(r.success).toBe(false);
    expect(familleRevoquee()).toBe(true);
    expect(Utilisateur.increment).toHaveBeenCalledWith('token_version', { where: { id: 'u-1' } });
  });

  test('course entre deux requêtes légitimes (rejeu dans la seconde) : refus simple, rien n\'est coupé', async () => {
    RefreshToken.findOne.mockResolvedValue({ utilisateurId: 'u-1', revoked: true, rotatedAt: ilYa(1000), expiresAt: new Date(Date.now() + 1e9) });

    const r = await AuthService.refresh({ refreshToken: jeton() });

    expect(r.success).toBe(false);
    expect(familleRevoquee()).toBe(false);
    expect(Utilisateur.increment).not.toHaveBeenCalled();
  });

  test('jeton révoqué VOLONTAIREMENT (déconnexion, changement de mot de passe) : rien n\'est coupé', async () => {
    RefreshToken.findOne.mockResolvedValue({ utilisateurId: 'u-1', revoked: true, rotatedAt: null, expiresAt: new Date(Date.now() + 1e9) });

    const r = await AuthService.refresh({ refreshToken: jeton() });

    expect(r.success).toBe(false);
    expect(familleRevoquee()).toBe(false);
    expect(Utilisateur.increment).not.toHaveBeenCalled();
  });

  test('une rotation normale marque l\'ancien jeton comme REMPLACÉ (rotatedAt)', async () => {
    const t = { commit: jest.fn(), rollback: jest.fn() };
    sequelize.transaction.mockResolvedValue(t);
    RefreshToken.findOne.mockResolvedValue({ utilisateurId: 'u-1', revoked: false, rotatedAt: null, expiresAt: new Date(Date.now() + 1e9) });
    Utilisateur.findByPk.mockResolvedValue({ id: 'u-1', statut: 'actif', role: 'ChefProjet', token_version: 0 });
    RefreshToken.count.mockResolvedValue(0);
    RefreshToken.findAll.mockResolvedValue([]);
    RefreshToken.destroy.mockResolvedValue(0);
    RefreshToken.create.mockResolvedValue({});

    const r = await AuthService.refresh({ refreshToken: jeton() });

    expect(r.success).toBe(true);
    const [valeurs, { where }] = RefreshToken.update.mock.calls[0];
    expect(valeurs.revoked).toBe(true);
    expect(valeurs.rotatedAt).toBeInstanceOf(Date);
    expect(where.revoked).toBe(false);
  });
});

// Le nettoyage qui conserve les jetons remplacés est vérifié dans
// jobs.echecsRemontes.test.js.
