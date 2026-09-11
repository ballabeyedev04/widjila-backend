'use strict';

/**
 * Tests — transfert de session du mobile vers le navigateur.
 *
 * ## Le défaut
 *
 * « Choisir cette formule » sur le mobile ouvre la page d'abonnement du web
 * dans le navigateur du téléphone. Ce navigateur n'avait aucune session : la
 * page enchaînait `/abonnement/status` → 401, `/auth/refresh` → 400
 * (« refreshToken manquant »), puis renvoyait vers la connexion. Payer depuis
 * le mobile était impossible sans se reconnecter à la main.
 *
 * ## Le remède, et ce qu'il ne doit PAS devenir
 *
 * Le mobile demande un code de transfert et le glisse dans l'adresse ; la page
 * l'échange contre une session. Ce code ouvre une session : il doit donc être
 * aussi fermé qu'une porte peut l'être — deux minutes, une seule utilisation,
 * inutilisable comme jeton d'accès ou comme refresh token. Ce sont ces
 * propriétés, et non le cas nominal seul, que ce fichier verrouille.
 */

jest.mock('../models/index.js', () => ({
  RefreshToken: {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    destroy: jest.fn(),
    count: jest.fn(),
  },
  Utilisateur: { findByPk: jest.fn() },
  MfaChallenge: { findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  ConnexionLog: { create: jest.fn() },
}));

jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));
// `auth.middleware` charge le modèle directement, hors de l'index.
jest.mock('../models/utilisateur.model.js', () => ({ findByPk: jest.fn() }));
// `otplib` est publié en modules ES — même doublure que les autres tests d'auth.
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({
  journaliserConnexion: jest.fn(),
}));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { RefreshToken, Utilisateur } = require('../models/index.js');
const sequelize = require('../config/db.js');
const { jwtConfig } = require('../config/security.js');
const { journaliserConnexion } = require('../modules/auth/service/connexionLog.service.js');
const authMiddleware = require('../middlewares/auth.middleware.js');
const AuthService = require('../modules/auth/service/auth.service.js');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const utilisateurActif = (surcharge = {}) => ({
  id: 'u-1',
  email: 'balla@widjila.com',
  role: 'Entreprise',
  statut: 'actif',
  organisationId: 'org-1',
  token_version: 3,
  update: jest.fn().mockResolvedValue(undefined),
  ...surcharge,
});

/** Un code tel que le service l'émet — ou presque, selon `payload`. */
const codeSigne = (payload = {}, options = { expiresIn: 120 }) => jwt.sign(
  { id: 'u-1', type: 'transfert_web', tv: 3, jti: crypto.randomUUID(), ...payload },
  jwtConfig.refreshSecret,
  options,
);

let transaction;

beforeEach(() => {
  jest.clearAllMocks();
  transaction = { commit: jest.fn(), rollback: jest.fn() };
  sequelize.transaction.mockResolvedValue(transaction);
  RefreshToken.create.mockResolvedValue({});
  RefreshToken.destroy.mockResolvedValue(0);
  RefreshToken.count.mockResolvedValue(0);
  Utilisateur.findByPk.mockResolvedValue(utilisateurActif());
});

describe('émission du code', () => {
  it('rend un code de deux minutes, typé, lié à l’utilisateur', async () => {
    const res = await AuthService.creerTransfertWeb(utilisateurActif());

    expect(res.success).toBe(true);
    expect(res.expiresIn).toBe(120);
    const decode = jwt.verify(res.code, jwtConfig.refreshSecret);
    expect(decode).toMatchObject({ id: 'u-1', type: 'transfert_web', tv: 3 });
    expect(decode.exp - decode.iat).toBe(120);
  });

  it('ne conserve que l’EMPREINTE du code, jamais le code lui-même', async () => {
    const { code } = await AuthService.creerTransfertWeb(utilisateurActif());

    const [ligne] = RefreshToken.create.mock.calls[0];
    expect(ligne.tokenHash).toBe(sha256(code));
    expect(JSON.stringify(ligne)).not.toContain(code);
    expect(ligne.utilisateurId).toBe('u-1');
    expect(ligne.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it('ne déconnecte aucun autre appareil pour faire de la place', async () => {
    // `_storeRefreshToken` supprime la session la plus ancienne au-delà de
    // cinq : un code de deux minutes ne doit pas faire tomber un téléphone.
    await AuthService.creerTransfertWeb(utilisateurActif());

    expect(RefreshToken.destroy).not.toHaveBeenCalled();
    expect(RefreshToken.count).not.toHaveBeenCalled();
  });
});

describe('le code n’ouvre rien d’autre que l’échange', () => {
  it('n’est pas accepté comme refresh token', async () => {
    const { code } = await AuthService.creerTransfertWeb(utilisateurActif());

    const res = await AuthService.refresh({ refreshToken: code });

    expect(res.success).toBe(false);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('n’est pas accepté comme jeton d’accès', async () => {
    const { code } = await AuthService.creerTransfertWeb(utilisateurActif());
    const req = { headers: { authorization: `Bearer ${code}` } };
    const next = jest.fn();

    await authMiddleware(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(req.user).toBeUndefined();
  });

  it('un refresh token présenté à l’échange est refusé', async () => {
    const refresh = jwt.sign({ id: 'u-1', type: 'refresh' }, jwtConfig.refreshSecret, { expiresIn: '7d' });

    const res = await AuthService.echangerTransfertWeb({ code: refresh });

    expect(res.success).toBe(false);
    expect(RefreshToken.destroy).not.toHaveBeenCalled();
  });
});

describe('échange du code', () => {
  it('consomme le code puis ouvre une session web complète', async () => {
    const code = codeSigne();
    RefreshToken.destroy.mockResolvedValueOnce(1);   // le code existait

    const res = await AuthService.echangerTransfertWeb({ code }, { ip: '10.0.0.1' });

    expect(res.success).toBe(true);
    expect(res.token).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.utilisateur.id).toBe('u-1');
    expect(transaction.commit).toHaveBeenCalled();
    expect(journaliserConnexion).toHaveBeenCalledWith(expect.objectContaining({
      utilisateurId: 'u-1', succes: true, donnees: { origine: 'transfert_mobile_web' },
    }));
  });

  it('la consommation est CONDITIONNELLE : empreinte, titulaire, non révoqué, non expiré', async () => {
    const code = codeSigne();
    RefreshToken.destroy.mockResolvedValueOnce(1);

    await AuthService.echangerTransfertWeb({ code });

    const { where } = RefreshToken.destroy.mock.calls[0][0];
    expect(where).toMatchObject({ tokenHash: sha256(code), utilisateurId: 'u-1', revoked: false });
    expect(where.expiresAt[Op.gt]).toBeInstanceOf(Date);
  });

  it('un code déjà servi n’ouvre RIEN — même rejoué dans la seconde', async () => {
    // Zéro ligne supprimée : un autre échange est passé avant. Le rejeu d'une
    // adresse retrouvée dans l'historique tombe exactement ici.
    RefreshToken.destroy.mockResolvedValueOnce(0);

    const res = await AuthService.echangerTransfertWeb({ code: codeSigne() });

    expect(res.success).toBe(false);
    expect(res.token).toBeUndefined();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('un code expiré est refusé avant même de toucher la base', async () => {
    const perime = codeSigne({ exp: Math.floor(Date.now() / 1000) - 5 }, {});

    const res = await AuthService.echangerTransfertWeb({ code: perime });

    expect(res.success).toBe(false);
    expect(RefreshToken.destroy).not.toHaveBeenCalled();
  });

  it('un code falsifié (autre secret) est refusé', async () => {
    const faux = jwt.sign({ id: 'u-1', type: 'transfert_web', tv: 3 }, 'un-autre-secret', { expiresIn: 120 });

    const res = await AuthService.echangerTransfertWeb({ code: faux });

    expect(res.success).toBe(false);
    expect(RefreshToken.destroy).not.toHaveBeenCalled();
  });

  it('un compte devenu inactif entre-temps ne reçoit pas de session', async () => {
    RefreshToken.destroy.mockResolvedValueOnce(1);
    Utilisateur.findByPk.mockResolvedValue(utilisateurActif({ statut: 'inactif' }));

    const res = await AuthService.echangerTransfertWeb({ code: codeSigne() });

    expect(res.success).toBe(false);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('un mot de passe changé depuis l’émission périme le code', async () => {
    RefreshToken.destroy.mockResolvedValueOnce(1);
    Utilisateur.findByPk.mockResolvedValue(utilisateurActif({ token_version: 4 }));

    const res = await AuthService.echangerTransfertWeb({ code: codeSigne({ tv: 3 }) });

    expect(res.success).toBe(false);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('tous les refus disent la même chose', async () => {
    // Détailler lequel des contrôles a échoué renseignerait celui qui essaie
    // des codes, sans rien apporter à l'utilisateur.
    const sansCode = await AuthService.echangerTransfertWeb({ code: '' });
    const falsifie = await AuthService.echangerTransfertWeb({ code: 'pas.un.jeton' });
    RefreshToken.destroy.mockResolvedValueOnce(0);
    const dejaServi = await AuthService.echangerTransfertWeb({ code: codeSigne() });

    expect(new Set([sansCode.message, falsifie.message, dejaServi.message]).size).toBe(1);
  });
});
