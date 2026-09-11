'use strict';

/**
 * Tests — métriques en mémoire (utils/metrics.js).
 *
 * Point de vigilance couvert : la clé de regroupement. Construite depuis
 * `req.baseUrl + req.route.path`, elle perdait son préfixe quand une erreur
 * sortait d'un routeur (Express a déjà restauré `baseUrl` au moment de la
 * réponse) : dix routes différentes finissaient sous « GET /:id ».
 */

const express = require('express');
const request = require('supertest');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');

beforeEach(() => metrics.reinitialiser());

describe('Histogramme', () => {
  it('rend des centiles approchés PAR EXCÈS, plafonnés au maximum observé', () => {
    const h = new metrics.Histogramme();
    for (let ms = 1; ms <= 100; ms += 1) h.observer(ms);

    const r = h.resume();
    expect(r.total).toBe(100);
    expect(r.p50Ms).toBe(50);
    expect(r.p95Ms).toBe(100);
    expect(r.p99Ms).toBe(100);
    expect(r.maxMs).toBe(100);
  });

  it('un histogramme vide ne rend aucun centile', () => {
    expect(new metrics.Histogramme().resume().p95Ms).toBeNull();
  });
});

function construireApp() {
  const app = express();
  app.use(metrics.mesurerRequetes);
  const routeur = express.Router();
  routeur.get('/chantiers/:id/reserves', (req, res) => res.json([]));
  routeur.get('/chantiers/:id', (req, res, next) => next(new Error('panne')));
  app.use('/api/v1', routeur);
  app.get('/uploads/plans/:f', (req, res) => res.send('x'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ success: false }));
  return app;
}

const ID = '3f1c2a44-8b7e-4d6a-9f00-1a2b3c4d5e6f';

describe('regroupement des requêtes', () => {
  it('normalise les identifiants et garde le préfixe, même pour une erreur sortie d’un routeur', async () => {
    const app = construireApp();
    await request(app).get(`/api/v1/chantiers/${ID}/reserves`);
    await request(app).get(`/api/v1/chantiers/${ID}`);
    await request(app).get('/uploads/plans/1734-ab12cd.pdf');
    await request(app).get('/wp-login.php');

    const { routes, requetes } = metrics.instantane();
    expect(Object.keys(routes).sort()).toEqual([
      'GET /api/v1/chantiers/:id',
      'GET /api/v1/chantiers/:id/reserves',
      'GET /uploads/*',
      'NON_ROUTEE',
    ]);
    expect(routes['GET /api/v1/chantiers/:id'].erreurs5xx).toBe(1);
    expect(requetes.parClasse).toMatchObject({ '2xx': 2, '4xx': 1, '5xx': 1 });
    expect(requetes.tauxErreurServeur).toBe(0.25);
  });

  it('expose un texte Prometheus lisible', async () => {
    await request(construireApp()).get(`/api/v1/chantiers/${ID}/reserves`);

    const texte = metrics.formatPrometheus();
    expect(texte).toContain('http_requetes_total{classe="2xx"} 1');
    expect(texte).toContain('http_requete_duree_ms_bucket{le="+Inf"} 1');
    expect(texte).toContain('http_route_requetes_total{route="GET /api/v1/chantiers/:id/reserves"} 1');
  });
});

it('une requête lente est journalisée avec son identifiant', async () => {
  let m;
  const ancien = process.env.SEUIL_REQUETE_LENTE_MS;
  process.env.SEUIL_REQUETE_LENTE_MS = '10';
  jest.isolateModules(() => {
    m = { metrics: require('../utils/metrics.js'), logger: require('../utils/logger.js') };
  });
  process.env.SEUIL_REQUETE_LENTE_MS = ancien;
  const warn = jest.spyOn(m.logger, 'warn').mockImplementation(() => m.logger);

  const app = express();
  app.use((req, res, next) => { req.id = 'req-lente-0001'; next(); });
  app.use(m.metrics.mesurerRequetes);
  app.get('/lent', (req, res) => setTimeout(() => res.json({}), 30));
  await request(app).get('/lent');

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Requête lente : GET /lent'), expect.objectContaining({ requestId: 'req-lente-0001' }));
});

it('les sondes en échec ne font pas échouer la lecture des métriques', () => {
  metrics.enregistrerSonde('cassee', () => { throw new Error('indisponible'); });
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);

  expect(metrics.instantane().sondes.cassee).toEqual({ erreur: 'indisponible' });
});
