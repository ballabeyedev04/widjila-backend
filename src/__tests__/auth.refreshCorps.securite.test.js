'use strict';

/**
 * Tests — le refresh token ne quitte pas son cookie httpOnly pour un navigateur.
 *
 * Le web reçoit son refresh token en cookie httpOnly, hors de portée du
 * JavaScript. Les réponses de login, de MFA et de refresh le RECOPIAIENT
 * pourtant dans le corps JSON, pour le mobile. Conséquence : une XSS dans
 * l'admin appelait `POST /auth/refresh` (cookie joint automatiquement) et
 * lisait dans la réponse un jeton de sept jours, renouvelable à l'infini
 * depuis la machine de l'attaquant — au lieu d'un jeton d'accès d'une heure.
 *
 * Le corps ne le porte plus que pour un client sans en-tête `Origin` : le
 * mobile, qui en a besoin et qui le stocke lui-même.
 */

jest.mock('../modules/auth/service/auth.service.js', () => ({
  login: jest.fn(), verifierMfa: jest.fn(), refresh: jest.fn(), logout: jest.fn(), register: jest.fn(),
}));

const AuthService = require('../modules/auth/service/auth.service.js');
const controleur = require('../modules/auth/controller/auth.controller.js');

const NAVIGATEUR = { origin: 'https://app.widjila.com', 'user-agent': 'Mozilla/5.0' };
const MOBILE = { 'user-agent': 'Dart/3.5 (dart:io)' };

function reponse() {
  const res = {};
  res.cookie = jest.fn(() => res);
  res.clearCookie = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function appeler(action, headers, { body = {}, cookies = {} } = {}) {
  const res = reponse();
  const next = jest.fn();
  await controleur[action]({ body, headers, cookies, ip: '10.0.0.1' }, res, next);
  expect(next).not.toHaveBeenCalled();
  return { corps: res.json.mock.calls[0][0], res };
}

const SUCCES = {
  success: true, token: 'jeton-acces', refreshToken: 'jeton-refresh',
  utilisateur: { id: 'u1', role: 'Client', prenom: 'Awa', nom: 'Sow' },
};

beforeEach(() => {
  AuthService.login.mockResolvedValue(SUCCES);
  AuthService.verifierMfa.mockResolvedValue(SUCCES);
  AuthService.refresh.mockResolvedValue(SUCCES);
});

describe.each([
  ['login', { body: { identifiant: 'a@x.io', mot_de_passe: 'x' } }],
  ['verifierMfa', { body: { code: '123456' }, cookies: { mfaToken: 'm' } }],
  ['refresh', { cookies: { refreshToken: 'ancien' } }],
])('%s', (action, requete) => {
  it('navigateur : refresh token en cookie httpOnly, JAMAIS dans le corps', async () => {
    const { corps, res } = await appeler(action, NAVIGATEUR, requete);

    expect(corps.data.refreshToken).toBeUndefined();
    expect(JSON.stringify(corps)).not.toContain('jeton-refresh');
    expect(res.cookie).toHaveBeenCalledWith('refreshToken', 'jeton-refresh', expect.objectContaining({ httpOnly: true }));
    expect(corps.data.token).toBe('jeton-acces');
  });

  it('mobile (sans Origin) : le refresh token reste dans le corps', async () => {
    const { corps } = await appeler(action, MOBILE, requete);

    expect(corps.data.refreshToken).toBe('jeton-refresh');
  });
});
