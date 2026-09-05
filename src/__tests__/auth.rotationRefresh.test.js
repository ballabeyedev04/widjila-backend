'use strict';

/**
 * Tests — rotation du refresh token sous concurrence.
 *
 * ## Le défaut
 *
 * `refresh()` lisait le jeton, vérifiait qu'il n'était pas révoqué, PUIS le
 * révoquait — sans rien qui verrouille la ligne entre les deux. Deux appels
 * simultanés portant le même jeton passaient donc tous deux le contrôle et
 * repartaient chacun avec un couple valide.
 *
 * Deux familles de jetons vivantes issues d'une seule : la rotation ne sert
 * alors plus à rien. Son intérêt est justement de rendre un jeton volé
 * détectable — s'il est rejoué après usage légitime, la seconde présentation
 * doit échouer. Sans arbitre, les deux réussissent.
 *
 * ## Le remède
 *
 * `UPDATE ... WHERE token_hash = ? AND revoked = false`. La première
 * transaction pose le verrou de ligne, la seconde attend puis ne touche
 * aucune ligne — et se voit refuser. C'est l'arbitrage par la base, pas par
 * le code.
 *
 * ## Ce que ces tests simulent
 *
 * Les modèles sont doublés : `RefreshToken.update` compte les lignes
 * touchées, comme le ferait PostgreSQL. Le premier appel en touche une, le
 * second zéro — c'est précisément la bascule que le service doit lire.
 */

jest.mock('../models/index.js', () => ({
  RefreshToken: {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    // `_storeRefreshToken` purge les jetons expires et plafonne le nombre de
    // sessions avant d'en enregistrer un neuf.
    destroy: jest.fn(),
    count: jest.fn(),
    findAll: jest.fn(),
  },
  Utilisateur: { findByPk: jest.fn() },
  MfaChallenge: { findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  ConnexionLog: { create: jest.fn() },
  UserOtp: { findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
}));

jest.mock('../config/db.js', () => ({
  transaction: jest.fn(),
}));

// `otplib` est publie en modules ES : jest ne sait pas le transformer ici, et
// la rotation du jeton n'a de toute facon rien a voir avec le MFA. Meme
// doublure que `auth.lockout.test.js`.
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({
  enregistrer: jest.fn(),
  compterEchecsRecents: jest.fn().mockResolvedValue(0),
}));

const jwt = require('jsonwebtoken');
const { RefreshToken, Utilisateur } = require('../models/index.js');
const sequelize = require('../config/db.js');
const { jwtConfig } = require('../config/security.js');
const AuthService = require('../modules/auth/service/auth.service.js');

/** Un jeton de renouvellement authentique, signé avec le vrai secret. */
const jetonValide = () =>
  jwt.sign({ id: 'u-1', type: 'refresh' }, jwtConfig.refreshSecret, { expiresIn: '7d' });

/** Transaction simulée — on observe seulement commit / rollback. */
const transactionSimulee = () => ({
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
});

let transaction;

beforeEach(() => {
  jest.clearAllMocks();

  transaction = transactionSimulee();
  sequelize.transaction.mockResolvedValue(transaction);

  // Le jeton existe, n'est ni révoqué ni expiré.
  RefreshToken.findOne.mockResolvedValue({
    tokenHash: 'peu-importe',
    revoked: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    update: jest.fn(),
  });
  RefreshToken.create.mockResolvedValue({});
  RefreshToken.destroy.mockResolvedValue(0);
  RefreshToken.count.mockResolvedValue(0);
  RefreshToken.findAll.mockResolvedValue([]);

  Utilisateur.findByPk.mockResolvedValue({
    id: 'u-1',
    role: 'ChefProjet',
    statut: 'actif',
    organisationId: 'org-1',
    tokenVersion: 1,
  });
});

describe('refresh — rotation', () => {
  it('émet un nouveau couple quand la révocation touche bien une ligne', async () => {
    RefreshToken.update.mockResolvedValue([1]);

    const res = await AuthService.refresh({ refreshToken: jetonValide() });

    expect(res.success).toBe(true);
    expect(res.token).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(transaction.commit).toHaveBeenCalled();
  });

  it('la révocation est CONDITIONNELLE — jamais un update aveugle', async () => {
    // Le point de tout le correctif : sans `revoked: false` dans le `where`,
    // deux appels concurrents réussissent tous les deux.
    RefreshToken.update.mockResolvedValue([1]);

    await AuthService.refresh({ refreshToken: jetonValide() });

    const [valeurs, options] = RefreshToken.update.mock.calls[0];
    expect(valeurs).toEqual({ revoked: true });
    expect(options.where).toMatchObject({ revoked: false });
    expect(options.where.tokenHash).toBeTruthy();
    expect(options.transaction).toBe(transaction);
  });

  it('REFUSE quand une autre requête a déjà consommé le jeton', async () => {
    // Zéro ligne touchée = quelqu'un est passé avant. Le perdant de la course
    // doit repartir en session expirée, pas avec un second couple valide.
    RefreshToken.update.mockResolvedValue([0]);

    const res = await AuthService.refresh({ refreshToken: jetonValide() });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/révoqué/i);
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('le perdant de la course n’obtient AUCUN jeton', async () => {
    RefreshToken.update.mockResolvedValue([0]);

    const res = await AuthService.refresh({ refreshToken: jetonValide() });

    expect(res.token).toBeUndefined();
    expect(res.refreshToken).toBeUndefined();
    // Et surtout : aucun jeton neuf n'a été enregistré.
    expect(RefreshToken.create).not.toHaveBeenCalled();
  });
});

describe('refresh — contrôles préalables', () => {
  it('refuse un jeton absent', async () => {
    const res = await AuthService.refresh({ refreshToken: null });
    expect(res.success).toBe(false);
  });

  it('refuse une signature invalide', async () => {
    const res = await AuthService.refresh({ refreshToken: 'pas.un.jeton' });
    expect(res.success).toBe(false);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('refuse un jeton d’ACCÈS présenté comme jeton de renouvellement', async () => {
    // Les deux sont des JWT ; seul le champ `type` les distingue. Sans ce
    // contrôle, un jeton d'accès volé se transformerait en session longue.
    const jetonAcces = jwt.sign({ id: 'u-1', type: 'access' }, jwtConfig.refreshSecret);

    const res = await AuthService.refresh({ refreshToken: jetonAcces });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/type/i);
  });

  it('refuse un jeton déjà révoqué, avant même d’ouvrir une transaction', async () => {
    RefreshToken.findOne.mockResolvedValue({
      revoked: true,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const res = await AuthService.refresh({ refreshToken: jetonValide() });

    expect(res.success).toBe(false);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('refuse un compte devenu INACTIF', async () => {
    // Un compte rejeté ou remis en attente garderait sinon un accès valide
    // jusqu'à l'expiration naturelle de son jeton.
    Utilisateur.findByPk.mockResolvedValue({ id: 'u-1', statut: 'inactif' });

    const res = await AuthService.refresh({ refreshToken: jetonValide() });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/actif/i);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});
