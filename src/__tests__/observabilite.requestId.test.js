'use strict';

/**
 * Tests — identifiant de corrélation de bout en bout.
 *
 * Avant : aucune requête ne portait d'identifiant. Une erreur signalée par un
 * utilisateur ne se retrouvait dans les journaux qu'en croisant l'heure, la
 * route et l'IP — et une ligne écrite au fond d'un service ne disait pas
 * quelle requête l'avait déclenchée.
 *
 * Vérifié ici, sur une vraie pile Express :
 *   - l'identifiant est généré, ou repris du client s'il est valide ;
 *   - il revient dans l'en-tête et dans le corps de toute erreur ;
 *   - CHAQUE ligne de journal écrite pendant la requête le porte, y compris
 *     après un `await` et après le parsing du corps JSON ;
 *   - des requêtes concurrentes ne mélangent jamais leurs identifiants.
 */

const express = require('express');
const request = require('supertest');
const Transport = require('winston-transport');
const logger = require('../utils/logger.js');
const requestId = require('../middlewares/requestId.middleware.js');
const errorHandler = require('../middlewares/errorHandler.middleware.js');
const { NotFoundError } = require('../errors/AppError.js');

const LEVEL = Symbol.for('level');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capturerJournal() {
  const lignes = [];
  const transport = new (class extends Transport {
    log(info, rappel) {
      lignes.push(info);
      rappel();
    }
  })();
  logger.add(transport);
  return { lignes, arreter: () => logger.remove(transport) };
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function construireApp() {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.get('/ok', async (req, res) => {
    await attendre(5);
    logger.info('dans le contrôleur');
    res.json({ ok: true });
  });
  app.post('/json', async (req, res) => {
    await attendre(2);
    logger.info('après parsing du corps');
    res.json({ recu: req.body });
  });
  app.get('/concurrent', async (req, res) => {
    await attendre(Math.floor(Math.random() * 20));
    logger.info(`ligne ${req.id}`);
    res.json({ id: req.id });
  });
  app.get('/introuvable', () => {
    throw new NotFoundError('Chantier introuvable');
  });
  app.get('/panne', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    err.name = 'SequelizeConnectionRefusedError';
    throw err;
  });
  app.use(errorHandler);
  return app;
}

let journal;
beforeEach(() => { journal = capturerJournal(); });
afterEach(() => journal.arreter());

describe('X-Request-Id', () => {
  it('est généré quand le client n’en fournit pas, et renvoyé en en-tête', async () => {
    const res = await request(construireApp()).get('/ok');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('reprend l’identifiant fourni par le client s’il est valide (id d’action de synchronisation)', async () => {
    const id = '0f3c9a2b-7d41-4e8a-9c55-2b1e6f0a9d13';
    const res = await request(construireApp()).get('/ok').set('X-Request-Id', id);

    expect(res.headers['x-request-id']).toBe(id);
    const ligne = journal.lignes.find((l) => l.message === 'dans le contrôleur');
    expect(ligne.requestId).toBe(id);
  });

  it.each([
    ['trop court', 'court'],
    ['trop long', 'a'.repeat(129)],
    ['caractères interdits', '<script>alert(1)</script>'],
    ['espaces', 'avec des espaces dedans'],
  ])('refuse un identifiant entrant %s et en génère un', async (_, valeur) => {
    const res = await request(construireApp()).get('/ok').set('X-Request-Id', valeur);

    expect(res.headers['x-request-id']).not.toBe(valeur);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});

describe('journal corrélé', () => {
  it('chaque ligne écrite pendant la requête porte son identifiant, après await et parsing JSON', async () => {
    const res = await request(construireApp()).post('/json').send({ a: 1 });

    const ligne = journal.lignes.find((l) => l.message === 'après parsing du corps');
    expect(ligne).toBeDefined();
    expect(ligne.requestId).toBe(res.headers['x-request-id']);
  });

  it('des requêtes concurrentes ne mélangent jamais leurs identifiants', async () => {
    const app = construireApp();
    const ids = Array.from({ length: 25 }, (_, i) => `concurrente-${String(i).padStart(4, '0')}`);

    await Promise.all(ids.map((id) => request(app).get('/concurrent').set('X-Request-Id', id)));

    const lignes = journal.lignes.filter((l) => String(l.message).startsWith('ligne '));
    expect(lignes).toHaveLength(25);
    for (const l of lignes) {
      // Le message a été écrit avec `req.id` ; le contexte doit dire la même chose.
      expect(l.requestId).toBe(l.message.slice('ligne '.length));
    }
  });
});

describe('corps d’erreur', () => {
  it('porte le requestId, le code uniforme, et garde les champs historiques', async () => {
    const res = await request(construireApp()).get('/introuvable');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Chantier introuvable',
      error: { code: 'RESSOURCE_INTROUVABLE', message: 'Chantier introuvable' },
      requestId: res.headers['x-request-id'],
    });
    // Pas de `code` au premier niveau sans code métier explicite : la
    // synchronisation mobile classe ses reprises sur cette valeur.
    expect(res.body.code).toBeUndefined();
  });

  it('une base injoignable répond 503 + Retry-After, et le journal d’erreur porte le requestId', async () => {
    const res = await request(construireApp()).get('/panne');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error.code).toBe('BASE_INDISPONIBLE');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432/);

    const ligne = journal.lignes.find((l) => l[LEVEL] === 'error');
    expect(ligne.requestId).toBe(res.headers['x-request-id']);
    expect(ligne.stack).toBeDefined();
  });
});
