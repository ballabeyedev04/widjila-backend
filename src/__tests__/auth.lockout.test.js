'use strict';

/**
 * Tests — modules/auth/service/auth.service.js : verrouillage anti brute-force
 * (audit — Bugs & fiabilité §1, l'une des trois zones "où une régression
 * coûte le plus cher").
 *
 * `AuthService.login()` touche la base (Sequelize), bcrypt et le journal de
 * connexion : on mocke ces trois dépendances pour isoler la LOGIQUE de
 * verrouillage (compteur d'échecs → blocage temporaire → déblocage), sans
 * dépendre d'une vraie base PostgreSQL.
 *
 * Portée volontairement limitée au chemin d'échec (mauvais mot de passe,
 * compte déjà bloqué, compte inactif, compte inexistant) : le chemin de
 * succès complet (émission des tokens) ouvre une transaction Sequelize réelle
 * (`emettreTokens`) qui appelle pour un test d'intégration avec une base de
 * test plutôt que des mocks supplémentaires ici.
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: { findOne: jest.fn() },
  Organisation: {},
  RefreshToken: {},
  MfaChallenge: {
    destroy: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({
  journaliserConnexion: jest.fn().mockResolvedValue(undefined),
}));
// mfa.service.js tire `otplib` → `@scure/base` (paquet ESM pur) qui casse le
// transform CommonJS par défaut de Jest. `login()` ne l'appelle que dans la
// branche `verifierMfa()`, jamais testée ici : un stub suffit et évite
// d'alourdir la config Jest (transformIgnorePatterns) pour une dépendance
// non exercée par cette suite.
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));

const { Utilisateur } = require('../models/index.js');
const bcrypt = require('bcryptjs');
const { journaliserConnexion } = require('../modules/auth/service/connexionLog.service.js');
const AuthService = require('../modules/auth/service/auth.service.js');

const MAX_TENTATIVES = 5;

function fakeUtilisateur(overrides = {}) {
  const u = {
    id: 'user-1',
    email: 'chef@chantier.test',
    telephone: null,
    mot_de_passe: 'hash-bcrypt-existant',
    statut: 'actif',
    tentatives_connexion: 0,
    compte_bloque_jusqua: null,
    email_verifie: true,
    mfa_active: false,
    ...overrides,
  };
  u.update = jest.fn(async (champs) => Object.assign(u, champs));
  return u;
}

describe('AuthService.login — verrouillage anti brute-force', () => {
  test('identifiant inexistant : compare quand même à un hash factice (anti timing-attack) et ne lève pas', async () => {
    Utilisateur.findOne.mockResolvedValue(null);
    bcrypt.compare.mockResolvedValue(false);

    const resultat = await AuthService.login({ identifiant: 'inconnu@test.com', mot_de_passe: 'x' });

    expect(resultat.success).toBe(false);
    expect(bcrypt.compare).toHaveBeenCalledTimes(1); // égalise le temps de réponse
    expect(journaliserConnexion).toHaveBeenCalledWith(expect.objectContaining({ succes: false }));
  });

  test('compte déjà verrouillé : rejette SANS appeler bcrypt.compare (court-circuit)', async () => {
    const dansUneHeure = new Date(Date.now() + 60 * 60 * 1000);
    Utilisateur.findOne.mockResolvedValue(fakeUtilisateur({ compte_bloque_jusqua: dansUneHeure }));

    const resultat = await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'peu importe' });

    expect(resultat.success).toBe(false);
    expect(resultat.message).toMatch(/bloqué/i);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('un blocage EXPIRÉ ne bloque plus (compte_bloque_jusqua dans le passé)', async () => {
    const ilYA1h = new Date(Date.now() - 60 * 60 * 1000);
    const utilisateur = fakeUtilisateur({ compte_bloque_jusqua: ilYA1h });
    Utilisateur.findOne.mockResolvedValue(utilisateur);
    bcrypt.compare.mockResolvedValue(false); // mauvais mot de passe pour ne pas atteindre emettreTokens()

    const resultat = await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'faux' });

    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    expect(resultat.message).not.toMatch(/bloqué/i);
  });

  test('compte inactif : rejette avant même de vérifier le mot de passe', async () => {
    Utilisateur.findOne.mockResolvedValue(fakeUtilisateur({ statut: 'inactif' }));

    const resultat = await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'x' });

    expect(resultat.success).toBe(false);
    expect(resultat.message).toMatch(/inactif/i);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('mauvais mot de passe : incrémente tentatives_connexion de 1', async () => {
    const utilisateur = fakeUtilisateur({ tentatives_connexion: 2 });
    Utilisateur.findOne.mockResolvedValue(utilisateur);
    bcrypt.compare.mockResolvedValue(false);

    await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'faux' });

    expect(utilisateur.update).toHaveBeenCalledWith({ tentatives_connexion: 3 });
    expect(utilisateur.compte_bloque_jusqua).toBeNull();
  });

  test(`atteindre ${MAX_TENTATIVES} échecs verrouille le compte ET remet le compteur à 0`, async () => {
    const utilisateur = fakeUtilisateur({ tentatives_connexion: MAX_TENTATIVES - 1 });
    Utilisateur.findOne.mockResolvedValue(utilisateur);
    bcrypt.compare.mockResolvedValue(false);

    await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'faux' });

    expect(utilisateur.tentatives_connexion).toBe(0);
    expect(utilisateur.compte_bloque_jusqua).toBeInstanceOf(Date);
    expect(utilisateur.compte_bloque_jusqua.getTime()).toBeGreaterThan(Date.now());
  });

  test('mot de passe correct réinitialise tentatives_connexion et compte_bloque_jusqua', async () => {
    const utilisateur = fakeUtilisateur({ tentatives_connexion: 3, mfa_active: true }); // mfa_active: true pour s'arrêter avant emettreTokens()
    Utilisateur.findOne.mockResolvedValue(utilisateur);
    bcrypt.compare.mockResolvedValue(true);

    await AuthService.login({ identifiant: 'chef@chantier.test', mot_de_passe: 'bon-mot-de-passe' });

    expect(utilisateur.update).toHaveBeenCalledWith({ tentatives_connexion: 0, compte_bloque_jusqua: null });
  });
});
