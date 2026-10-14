'use strict';

/**
 * Sécurité — plafond de codes TOTP par challenge MFA (audit SC-02).
 *
 * Le compteur était lu, incrémenté en mémoire puis réécrit : des requêtes
 * PARALLÈLES portant le même mfaToken lisaient toutes `tentatives = 0` et
 * testaient chacune un code. Le plafond de 5 codes ne tenait plus.
 *
 * La tentative est désormais RÉSERVÉE par la base avant toute vérification
 * (UPDATE conditionnel `tentatives < MAX`). Le double ci-dessous rejoue ce
 * que fait PostgreSQL : un compteur partagé, incrémenté seulement sous le
 * plafond — c'est lui que des requêtes concurrentes se disputent.
 */

const crypto = require('crypto');

const etat = { tentatives: 0, existe: true };

jest.mock('../models/index.js', () => ({
  Utilisateur: { findByPk: jest.fn() },
  Organisation: {},
  RefreshToken: {},
  MfaChallenge: {
    findOne: jest.fn(),
    update: jest.fn(),
    destroy: jest.fn(),
  },
}));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({
  journaliserConnexion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn(() => false) }));

const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/security.js');
const { Utilisateur, MfaChallenge } = require('../models/index.js');
const MfaService = require('../modules/auth/service/mfa.service.js');
const AuthService = require('../modules/auth/service/auth.service.js');

const MAX = 5;

function preparer() {
  etat.tentatives = 0;
  etat.existe = true;
  const mfaToken = jwt.sign({ id: 'u-1', type: 'mfa', jti: crypto.randomUUID() }, jwtConfig.secret, { expiresIn: '10m' });
  MfaChallenge.findOne.mockImplementation(async () => (etat.existe
    ? { id: 'ch-1', tentatives: etat.tentatives, expiresAt: new Date(Date.now() + 60_000), destroy: jest.fn() }
    : null));
  MfaChallenge.update.mockImplementation(async (_valeurs, { where }) => {
    // Une micro-attente entre lecture et décision : sans atomicité côté
    // service, c'est ici que des requêtes parallèles se chevaucheraient.
    await new Promise((r) => setImmediate(r));
    if (!etat.existe || where.id !== 'ch-1') return [0, []];
    if (etat.tentatives >= MAX) return [0, []];
    etat.tentatives += 1;
    return [1, [{ tentatives: etat.tentatives }]];
  });
  MfaChallenge.destroy.mockImplementation(async () => {
    const supprime = etat.existe ? 1 : 0;
    etat.existe = false;
    return supprime;
  });
  Utilisateur.findByPk.mockResolvedValue({ id: 'u-1', email: 'u@exemple.test', mfa_active: true, mfa_secret: 'secret' });
  return mfaToken;
}

describe('AuthService.verifierMfa — plafond atomique des tentatives', () => {
  test('20 codes envoyés EN PARALLÈLE : au plus 5 sont réellement vérifiés', async () => {
    const mfaToken = preparer();
    const reponses = await Promise.all(
      Array.from({ length: 20 }, () => AuthService.verifierMfa({ mfaToken, code: '000000' })),
    );

    expect(MfaService.verify.mock.calls.length).toBeLessThanOrEqual(MAX);
    expect(reponses.every((r) => r.success === false)).toBe(true);
    // Le challenge est détruit une fois le plafond atteint : il faut refaire un login complet.
    expect(etat.existe).toBe(false);
  });

  test('la réservation est conditionnelle (tentatives < MAX), jamais une réécriture d\'une valeur lue', async () => {
    const mfaToken = preparer();
    await AuthService.verifierMfa({ mfaToken, code: '000000' });

    const [, options] = MfaChallenge.update.mock.calls[0];
    expect(options.where.id).toBe('ch-1');
    expect(Object.getOwnPropertySymbols(options.where.tentatives).length).toBe(1); // Op.lt
    expect(Object.values(options.where.tentatives)[0] ?? options.where.tentatives[Object.getOwnPropertySymbols(options.where.tentatives)[0]]).toBe(MAX);
  });

  test('un code valide présenté deux fois en parallèle n\'ouvre qu\'UNE session', async () => {
    const mfaToken = preparer();
    MfaService.verify.mockReturnValue(true);
    const emettre = jest.spyOn(AuthService, 'emettreTokens').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });

    const reponses = await Promise.all([
      AuthService.verifierMfa({ mfaToken, code: '123456' }),
      AuthService.verifierMfa({ mfaToken, code: '123456' }),
    ]);

    expect(reponses.filter((r) => r.success).length).toBe(1);
    expect(emettre).toHaveBeenCalledTimes(1);
  });
});
