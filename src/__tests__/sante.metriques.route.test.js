'use strict';

/**
 * Tests — sondes de santé, métriques et 404, sur l'application RÉELLE.
 *
 * Défauts reproduits sur l'ancienne sonde `/health` :
 *   - la base n'avait aucun délai : pool épuisé, la sonde attendait
 *     l'acquisition d'une connexion (30 s), bien au-delà des 10 s du
 *     HEALTHCHECK Docker ;
 *   - chaque appel refaisait une requête SQL (le mobile l'appelle toutes les
 *     20 s quand il se croit hors ligne) ;
 *   - aucune sonde de vie sans dépendance : une base en panne rendait le
 *     process « mort » aux yeux d'un orchestrateur.
 */

const { ConnectionRefusedError } = require('sequelize');

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

const request = require('supertest');
const sequelize = require('../config/db.js');
const r2 = require('../infrastructure/r2.service.js');
const app = require('../app.js');

// La sonde met son bilan en cache 5 s : chaque test avance l'horloge pour
// repartir d'un cache vide.
let horloge = Date.now();
const dateNow = Date.now.bind(Date);
beforeEach(() => {
  horloge += 60_000;
  const decalage = horloge - dateNow();
  jest.spyOn(Date, 'now').mockImplementation(() => dateNow() + decalage);
  jest.spyOn(r2, 'ping').mockResolvedValue({ configure: false, joignable: null });
});

describe('/health/live', () => {
  it('répond 200 sans consulter la base', async () => {
    const authenticate = jest.spyOn(sequelize, 'authenticate');

    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe('/health (disponibilité)', () => {
  it('base joignable : 200, avec un X-Request-Id', async () => {
    jest.spyOn(sequelize, 'authenticate').mockResolvedValue();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'connected', redis: 'non configuré' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('base injoignable : 503', async () => {
    jest.spyOn(sequelize, 'authenticate').mockRejectedValue(new ConnectionRefusedError(new Error('ECONNREFUSED')));

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('disconnected');
  });

  it('base qui ne répond pas (pool épuisé) : 503 en ~3 s, pas un blocage', async () => {
    jest.spyOn(sequelize, 'authenticate').mockImplementation(() => new Promise(() => {}));

    const debut = dateNow();
    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(dateNow() - debut).toBeLessThan(5000);
  }, 10_000);

  it('un seul contrôle de la base pour 20 appels simultanés, puis cache de 5 s', async () => {
    const authenticate = jest.spyOn(sequelize, 'authenticate').mockResolvedValue();

    await Promise.all(Array.from({ length: 20 }, () => request(app).get('/health')));
    await request(app).get('/health');

    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('stockage configuré mais muet : compté comme dégradé (il était compté sain)', async () => {
    jest.spyOn(sequelize, 'authenticate').mockResolvedValue();
    r2.ping.mockImplementation(() => new Promise(() => {}));

    const res = await request(app).get('/health');

    expect(res.status).toBe(200); // la base répond : l'instance sert encore
    expect(res.body).toMatchObject({ status: 'degraded', storage: 'disconnected' });
  }, 10_000);
});

describe('404 et CORS', () => {
  it('une route inconnue répond au format uniforme', async () => {
    const res = await request(app).get('/api/v1/nexiste-pas');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Ressource introuvable',
      error: { code: 'ROUTE_INTROUVABLE' },
      requestId: res.headers['x-request-id'],
    });
  });

  it('le pré-vol CORS autorise l’en-tête X-Request-Id', async () => {
    const res = await request(app)
      .options('/api/v1/chantiers')
      .set('Origin', 'https://exemple.test')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-request-id');

    expect(res.headers['access-control-allow-headers']).toMatch(/X-Request-Id/i);
  });
});

describe('/metrics', () => {
  afterEach(() => { delete process.env.METRICS_TOKEN; });

  it('hors production sans jeton : JSON des métriques', async () => {
    jest.spyOn(sequelize, 'authenticate').mockResolvedValue();
    await request(app).get('/health');

    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.body.requetes.total).toBeGreaterThan(0);
    expect(res.body.routes['GET /health']).toBeDefined();
    expect(res.body.process.memoire.rssMo).toBeGreaterThan(0);
  });

  it('avec METRICS_TOKEN : 401 sans le jeton, 200 avec, format Prometheus disponible', async () => {
    process.env.METRICS_TOKEN = 'jeton-de-metriques-test';

    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer mauvais')).status).toBe(401);

    const res = await request(app)
      .get('/metrics?format=prometheus')
      .set('Authorization', 'Bearer jeton-de-metriques-test');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requetes_total');
  });
});

describe('arrêt propre', () => {
  // Dernier test du fichier : le drapeau d'arrêt est définitif pour le process.
  it('la sonde de disponibilité répond 503 dès que l’arrêt commence', async () => {
    jest.spyOn(sequelize, 'authenticate').mockResolvedValue();
    require('../utils/etatApplication.js').signalerArret();

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('arret en cours');
    expect((await request(app).get('/health/live')).status).toBe(200);
  });
});
