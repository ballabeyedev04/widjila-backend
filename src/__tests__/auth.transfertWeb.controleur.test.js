'use strict';

/**
 * Tests — réponses HTTP du transfert de session mobile → navigateur.
 *
 * L'échange ouvre une session dans un NAVIGATEUR : le refresh token doit y
 * arriver en cookie httpOnly et jamais dans le corps JSON, où une XSS le
 * lirait (voir `auth.refreshCorps.securite.test.js`, même règle pour la
 * connexion). Contrairement à la connexion, il n'y a pas de variante mobile :
 * même sans en-tête `Origin`, le corps ne le porte pas.
 */

jest.mock('../modules/auth/service/auth.service.js', () => ({
  creerTransfertWeb: jest.fn(), echangerTransfertWeb: jest.fn(),
}));

const AuthService = require('../modules/auth/service/auth.service.js');
const controleur = require('../modules/auth/controller/auth.controller.js');

function reponse() {
  const res = {};
  res.cookie = jest.fn(() => res);
  res.clearCookie = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const UTILISATEUR = { id: 'u1', role: 'Entreprise', prenom: 'Awa', nom: 'Sow', statut: 'actif' };

describe('POST /auth/transfert-web', () => {
  it('émet le code pour l’utilisateur de la SESSION, jamais pour un identifiant du corps', async () => {
    AuthService.creerTransfertWeb.mockResolvedValue({ success: true, code: 'code-court', expiresIn: 120 });
    const res = reponse();
    const next = jest.fn();

    await controleur.creerTransfertWeb(
      { user: UTILISATEUR, body: { id: 'autre-utilisateur' }, headers: {} }, res, next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(AuthService.creerTransfertWeb).toHaveBeenCalledWith(UTILISATEUR);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].data).toEqual({ code: 'code-court', expiresIn: 120 });
  });
});

describe('POST /auth/transfert-web/echange', () => {
  it.each([
    ['navigateur', { origin: 'https://app.widjila.com' }],
    ['client sans Origin', {}],
  ])('%s : refresh token en cookie httpOnly, JAMAIS dans le corps', async (_, headers) => {
    AuthService.echangerTransfertWeb.mockResolvedValue({
      success: true, token: 'jeton-acces', refreshToken: 'jeton-refresh', utilisateur: UTILISATEUR,
    });
    const res = reponse();
    const next = jest.fn();

    await controleur.echangerTransfertWeb({ body: { code: 'c' }, headers, ip: '10.0.0.1' }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith('refreshToken', 'jeton-refresh', expect.objectContaining({ httpOnly: true }));
    const corps = res.json.mock.calls[0][0];
    expect(corps.data.token).toBe('jeton-acces');
    expect(corps.data.utilisateur.id).toBe('u1');
    expect(JSON.stringify(corps)).not.toContain('jeton-refresh');
  });

  it('un code refusé répond 400 TRANSFERT_INVALIDE, sans poser de cookie', async () => {
    // 400 et non 401 : l'intercepteur du web tente un renouvellement de
    // session sur tout 401 — il n'y a ici aucune session à renouveler.
    AuthService.echangerTransfertWeb.mockResolvedValue({ success: false, message: 'Lien expiré' });
    const res = reponse();
    const next = jest.fn();

    await controleur.echangerTransfertWeb({ body: { code: 'c' }, headers: {}, ip: '10.0.0.1' }, res, next);

    const erreur = next.mock.calls[0][0];
    expect(erreur.statusCode).toBe(400);
    expect(erreur.code).toBe('TRANSFERT_INVALIDE');
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
