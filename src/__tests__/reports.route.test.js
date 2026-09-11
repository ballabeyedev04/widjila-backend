'use strict';

/**
 * Tests — les routes du § 9 du cahier des charges Rapports, sur
 * l'application RÉELLEMENT montée.
 *
 * ```
 * POST   /api/reports                 GET  /api/reports/{id}/preview
 * GET    /api/reports                 GET  /api/reports/{id}/download
 * GET    /api/reports/{id}            POST /api/reports/{id}/send-email
 * PATCH  /api/reports/{id}            POST /api/reports/{id}/share
 * POST   /api/reports/{id}/generate   GET  /api/reports/{id}/history
 *                                     POST /api/reports/{id}/duplicate
 * ```
 *
 * Une route peut être écrite dans le fichier de routage et rester
 * inaccessible — un routeur monté plus haut qui intercepte le préfixe, un
 * contrôleur mal exporté. On interroge donc l'application montée : sans jeton,
 * une route EXISTANTE et GARDÉE répond 401. Un 404 dirait qu'elle n'est pas
 * montée ; un 200, qu'elle est ouverte à tous.
 *
 * Le lien PUBLIC du § 14, lui, doit répondre SANS jeton : c'est son objet.
 */

const { Readable } = require('node:stream');

jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verifySync: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
jest.mock('../middlewares/rateLimit.middleware.js', () => {
  const passe = (req, res, next) => next();
  return {
    authRateLimit: passe,
    sessionRateLimit: passe,
    mutationRateLimit: passe,
    adminRateLimit: passe,
    otpEmailRateLimit: passe,
    authenticatedRateLimit: passe,
    envoiRapportRateLimit: passe,
    rateLimitConfig: {},
  };
});

const mockOuvrirLien = jest.fn();
jest.mock('../modules/rapport/service/rapportPartage.service.js', () => ({
  ouvrir: (...a) => mockOuvrirLien(...a),
  creer: jest.fn(),
  lister: jest.fn(),
  revoquer: jest.fn(),
  lienPourEnvoi: jest.fn(),
}));

const request = require('supertest');
const app = require('../app.js');

const ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mockOuvrirLien.mockReset().mockResolvedValue({ success: false, message: 'Ce lien n’est plus valide.' });
});

describe('§ 9 — les routes existent et sont gardées', () => {
  it.each([
    ['post', '/api/v1/reports'],
    ['get', '/api/v1/reports'],
    ['get', '/api/v1/reports/modeles'],
    ['get', `/api/v1/reports/${ID}`],
    ['patch', `/api/v1/reports/${ID}`],
    ['post', `/api/v1/reports/${ID}/generate`],
    ['post', `/api/v1/reports/${ID}/generate-by-company`],
    ['get', `/api/v1/reports/${ID}/preview`],
    ['get', `/api/v1/reports/${ID}/download`],
    ['get', `/api/v1/reports/${ID}/send-email`],
    ['post', `/api/v1/reports/${ID}/send-email`],
    ['post', `/api/v1/reports/${ID}/share`],
    ['get', `/api/v1/reports/${ID}/shares`],
    ['delete', `/api/v1/reports/${ID}/shares/${ID}`],
    ['get', `/api/v1/reports/${ID}/history`],
    ['post', `/api/v1/reports/${ID}/duplicate`],
    ['post', `/api/v1/reports/${ID}/archive`],
    ['delete', `/api/v1/reports/${ID}`],
  ])('%s %s répond 401 sans jeton', async (methode, chemin) => {
    const reponse = await request(app)[methode](chemin);
    expect(reponse.status).toBe(401);
  });

  it('l’ancien point d’entrée reste monté pour les clients déjà installés', async () => {
    const reponse = await request(app).post(`/api/v1/chantiers/${ID}/rapports/generer`);
    expect(reponse.status).toBe(401);
  });
});

describe('§ 14 — le lien public', () => {
  it.each(['/api/v1/r/jeton-inconnu', '/r/jeton-inconnu'])(
    '%s répond SANS jeton, par une page lisible — pas un 401',
    async (chemin) => {
      const reponse = await request(app).get(chemin);

      expect(reponse.status).toBe(404);
      expect(reponse.headers['content-type']).toMatch(/text\/html/);
      expect(reponse.text).toContain('plus valide');
      expect(mockOuvrirLien).toHaveBeenCalledWith('jeton-inconnu', expect.objectContaining({ utilisateur: null }));
    },
  );

  it('un lien valide sert le PDF en ligne, sans cache', async () => {
    mockOuvrirLien.mockResolvedValue({
      success: true,
      stream: Readable.from([Buffer.from('%PDF-1.7 contenu')]),
      contentType: 'application/pdf',
      nom: 'Rapport global.pdf',
    });

    const reponse = await request(app).get('/r/jeton-valide');

    expect(reponse.status).toBe(200);
    expect(reponse.headers['content-type']).toBe('application/pdf');
    expect(reponse.headers['content-disposition']).toMatch(/^inline;/);
    expect(reponse.headers['cache-control']).toBe('private, no-store');
  });

  it('un lien protégé demande de se connecter (401)', async () => {
    mockOuvrirLien.mockResolvedValue({
      success: false, authentificationRequise: true, message: 'Ce rapport est protégé.',
    });

    const reponse = await request(app).get('/api/v1/r/jeton-protege');

    expect(reponse.status).toBe(401);
    expect(reponse.text).toContain('protégé');
  });

  it('un jeton d’authentification INVALIDE est refusé, pas ignoré', async () => {
    const reponse = await request(app).get('/r/jeton').set('Authorization', 'Bearer faux');

    expect(reponse.status).toBe(401);
    expect(mockOuvrirLien).not.toHaveBeenCalled();
  });
});
