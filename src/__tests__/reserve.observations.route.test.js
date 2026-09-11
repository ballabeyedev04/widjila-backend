'use strict';

/**
 * Tests — `GET /reserves/observations` est montée, gardée, et n'est pas
 * capturée par `/reserves/:id`.
 *
 * `/reserves/:id` accepte n'importe quel segment : déclarée après lui, la
 * route des observations répondrait « Ressource introuvable » (identifiant
 * « observations » refusé comme UUID). Sans jeton, une route montée et gardée
 * répond 401.
 */

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

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../app.js');

it('sans jeton : 401 (route montée et gardée), et non 404', async () => {
  const res = await request(app).get('/api/v1/reserves/observations?q=coi');

  expect(res.status).toBe(401);
});

it('déclarée AVANT /reserves/:id dans le routeur', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/reserve/route/reserve.route.js'), 'utf8');

  expect(source.indexOf("'/reserves/observations'")).toBeGreaterThan(0);
  expect(source.indexOf("'/reserves/observations'")).toBeLessThan(source.indexOf("'/reserves/:id'"));
});
