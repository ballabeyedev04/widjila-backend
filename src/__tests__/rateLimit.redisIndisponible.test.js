'use strict';

/**
 * Tests — une panne de Redis ne devient pas une panne de l'authentification.
 *
 * Défaut reproduit : `RedisStore` (rate-limit-redis) charge ses scripts Lua
 * UNE fois, dans `init()`, et garde la promesse de leur empreinte. Redis
 * injoignable à cet instant — ce qui arrive à CHAQUE démarrage depuis que le
 * client refuse toute commande avant d'être connecté (`enableOfflineQueue:
 * false`) — et la promesse reste rejetée pour toujours : la bibliothèque ne
 * la recharge que sur l'erreur NOSCRIPT.
 *   - sans `passOnStoreError` : login, refresh, logout répondaient 500 ;
 *   - avec, mais sans correctif : la limitation anti force brute était
 *     désactivée EN SILENCE jusqu'au redémarrage de l'API.
 */

const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { StoreRedisResilient, journalStore } = require('../middlewares/rateLimit.middleware.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');

/** Redis simulé : refuse tout tant qu'il est « coupé », puis compte. */
function fauxRedis() {
  const etat = { disponible: false, compteurs: new Map() };
  const sendCommand = async (...args) => {
    if (!etat.disponible) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    const [commande] = args;
    if (commande === 'SCRIPT') return `sha-${args[2].length}`;
    if (commande === 'EVALSHA') {
      const cle = args[3];
      const n = (etat.compteurs.get(cle) || 0) + 1;
      etat.compteurs.set(cle, n);
      return [n, 60000];
    }
    return 1; // DECR, DEL
  };
  return { etat, sendCommand };
}

beforeEach(() => {
  metrics.reinitialiser();
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

describe('reproduction — le store d’origine', () => {
  it('reste cassé après le retour de Redis', async () => {
    const redis = fauxRedis();
    const store = new RedisStore({ prefix: 'rl:t:', sendCommand: redis.sendCommand });
    await store.init({ windowMs: 60000 }).catch(() => {});

    redis.etat.disponible = true;

    await expect(store.increment('1.2.3.4')).rejects.toThrow(/enableOfflineQueue/);
    await expect(store.increment('1.2.3.4')).rejects.toThrow(/enableOfflineQueue/);
  });

  it('sans passOnStoreError, chaque requête protégée répond 500', async () => {
    const redis = fauxRedis();
    const app = express();
    app.use(rateLimit({
      windowMs: 60000, limit: 5, store: new RedisStore({ prefix: 'rl:t2:', sendCommand: redis.sendCommand }),
      validate: false, logger: { error() {}, warn() {} },
    }));
    app.get('/login', (req, res) => res.json({ ok: true }));

    const res = await request(app).get('/login');
    expect(res.status).toBe(500);
  });
});

describe('StoreRedisResilient', () => {
  it('se rétablit dès que la connexion Redis redevient prête', async () => {
    const redis = fauxRedis();
    const store = new StoreRedisResilient({ prefix: 'rl:t3:', sendCommand: redis.sendCommand });
    await store.init({ windowMs: 60000 }).catch(() => {});

    redis.etat.disponible = true;
    await store.rechargerSiNecessaire(); // ce que fait l'écouteur 'ready'

    await expect(store.increment('1.2.3.4')).resolves.toMatchObject({ totalHits: 1 });
    await expect(store.increment('1.2.3.4')).resolves.toMatchObject({ totalHits: 2 });
  });

  it('se rétablit aussi sans événement, après un échec (tentatives espacées de 2 s)', async () => {
    const redis = fauxRedis();
    const store = new StoreRedisResilient({ prefix: 'rl:t4:', sendCommand: redis.sendCommand });
    await store.init({ windowMs: 60000 }).catch(() => {});
    redis.etat.disponible = true;

    const maintenant = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(maintenant + 3000);

    await expect(store.increment('ip')).rejects.toThrow(); // réattend l'ancienne promesse, puis recharge
    await expect(store.increment('ip')).resolves.toMatchObject({ totalHits: 1 });
  });

  it('ne martèle pas un Redis en panne : au plus un rechargement toutes les 2 s', async () => {
    const redis = fauxRedis();
    const store = new StoreRedisResilient({ prefix: 'rl:t5:', sendCommand: redis.sendCommand });
    await store.init({ windowMs: 60000 }).catch(() => {});
    const charger = jest.spyOn(store, '_chargerScripts');

    for (let i = 0; i < 10; i += 1) await store.increment('ip').catch(() => {});

    expect(charger).not.toHaveBeenCalled();
  });
});

describe('limiteur complet', () => {
  it('Redis coupé : les requêtes passent (pas de 500), l’incident est journalisé et compté ; Redis revenu : la limite s’applique', async () => {
    const redis = fauxRedis();
    const store = new StoreRedisResilient({ prefix: 'rl:t6:', sendCommand: redis.sendCommand });
    const app = express();
    app.use(rateLimit({
      windowMs: 60000, limit: 2, store, passOnStoreError: true, logger: journalStore, validate: false,
    }));
    app.get('/login', (req, res) => res.json({ ok: true }));

    // Panne : aucune requête n'échoue à cause du compteur.
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
    }
    expect(metrics.instantane().compteurs['rate_limit.erreur_store']).toBeGreaterThanOrEqual(4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[rate-limit]'), expect.any(Object));

    // Retour de Redis : la protection reprend.
    redis.etat.disponible = true;
    await store.rechargerSiNecessaire();
    expect((await request(app).get('/login')).status).toBe(200);
    expect((await request(app).get('/login')).status).toBe(200);
    expect((await request(app).get('/login')).status).toBe(429);
  });
});
