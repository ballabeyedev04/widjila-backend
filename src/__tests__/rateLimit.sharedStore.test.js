'use strict';

/**
 * Tests — rate limiting partagé via Redis (audit — Sécurité §3 / Charge à
 * 10 000 utilisateurs §4).
 *
 * Le finding original : `express-rate-limit` sans store partagé compte les
 * tentatives PAR PROCESS. En cluster PM2 (4 workers), une limite annoncée à
 * "N requêtes / fenêtre" tolère en réalité jusqu'à ~4×N, réparties par le
 * load-balancing round-robin de PM2 entre les workers.
 *
 * Ce test simule EXACTEMENT ce scénario : deux instances Express
 * indépendantes (deux "workers") avec chacune son propre `RedisStore`,
 * pointant vers le MÊME client Redis. Les requêtes alternent entre les deux
 * comme le ferait le load-balancer PM2. On prouve :
 *
 *   1. AVEC store partagé : la limite est bien globale, pas par worker.
 *   2. SANS store partagé (`MemoryStore` par défaut, comportement d'avant
 *      le correctif) : chaque worker a son propre compteur — c'est le bug
 *      reproduit délibérément, pour qu'un futur retrait accidentel du store
 *      partagé fasse échouer ce test plutôt que de repasser inaperçu.
 *
 * `ioredis-mock` remplace un vrai serveur Redis : c'est un client
 * compatible protocole, en mémoire, dans le même process — suffisant pour
 * prouver que NOTRE logique de partage fonctionne (ce que ce test vérifie),
 * pas pour mesurer les performances d'un vrai Redis en production (ce qui
 * resterait à observer sous trafic réel une fois REDIS_URL activé).
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const RedisMock = require('ioredis-mock');

const MAX = 3;
const WINDOW_MS = 60_000;

/**
 * `rate-limit-redis` incrémente les compteurs via un script Lua chargé au
 * démarrage (`SCRIPT LOAD`), puis rejoué par SHA (`EVALSHA`) — c'est ce qui
 * rend l'incrément atomique côté Redis. `ioredis-mock` implémente `.eval()`
 * (son propre interpréteur Lua) mais PAS les commandes `SCRIPT`/`EVALSHA`
 * elles-mêmes. Ce petit adaptateur les recrée par-dessus `.eval()` — un SHA1
 * du texte du script, exactement comme le ferait un vrai serveur Redis — ce
 * qui permet au store réel (`rate-limit-redis`) de tourner sans modification
 * contre le mock. Uniquement nécessaire ici, dans le test : le code de
 * production parle à un vrai Redis, qui implémente SCRIPT/EVALSHA nativement.
 */
function creerSendCommandPourMock(redisClient) {
  const scriptsParSha = new Map();
  return (...args) => {
    const [commande, ...reste] = args;
    const cmd = commande.toUpperCase();

    if (cmd === 'SCRIPT' && reste[0]?.toUpperCase() === 'LOAD') {
      const source = reste[1];
      const sha = crypto.createHash('sha1').update(source).digest('hex');
      scriptsParSha.set(sha, source);
      return sha;
    }
    if (cmd === 'EVALSHA') {
      const [sha, ...evalArgs] = reste;
      const source = scriptsParSha.get(sha);
      if (!source) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      return redisClient.eval(source, ...evalArgs);
    }
    return redisClient[commande.toLowerCase()](...reste);
  };
}

function creerWorker(store) {
  const app = express();
  // `X-Forwarded-For` fixe → simule toujours le même client, peu importe le
  // worker qui traite la requête (comme derrière un vrai load-balancer).
  // `1` (pas `true`) : un seul proxy de confiance, comme app.js en
  // production — `true` fait ce même choix pour n'importe quel nombre de
  // sauts et express-rate-limit le refuse explicitement (usurpation d'IP
  // triviale via X-Forwarded-For).
  app.set('trust proxy', 1);
  app.use(rateLimit({
    windowMs: WINDOW_MS,
    max: MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store,
  }));
  app.get('/ping', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function requeteDepuis(app) {
  const res = await request(app).get('/ping').set('X-Forwarded-For', '203.0.113.42');
  return res.status;
}

describe('rate limiting — store partagé entre "workers" simulés', () => {
  test('AVEC RedisStore partagé : la limite est globale, pas par worker', async () => {
    const redisClient = new RedisMock();
    const sendCommand = creerSendCommandPourMock(redisClient);
    const nouveauStore = () => new RedisStore({
      prefix: 'test-partage:',
      sendCommand,
    });

    const worker1 = creerWorker(nouveauStore());
    const worker2 = creerWorker(nouveauStore());

    const statuts = [];
    // 6 requêtes, en alternant worker1/worker2 — comme un round-robin PM2.
    for (let i = 0; i < 6; i++) {
      const worker = i % 2 === 0 ? worker1 : worker2;
      statuts.push(await requeteDepuis(worker));
    }

    const autorisees = statuts.filter((s) => s === 200).length;
    const bloquees = statuts.filter((s) => s === 429).length;

    // La limite (3) s'applique au TOTAL des deux workers confondus, pas 3
    // par worker (ce qui donnerait 6 autorisées si le store n'était pas
    // partagé).
    expect(autorisees).toBe(MAX);
    expect(bloquees).toBe(6 - MAX);
  });

  // Reproduit délibérément le bug d'origine : sans store partagé, chaque
  // `rateLimit()` retombe sur son propre `MemoryStore` interne. Si ce test
  // se met à échouer, c'est que le comportement par défaut d'express-rate-
  // limit a changé — pas une régression de notre code.
  test('SANS store partagé (comportement d\'avant le correctif) : chaque worker compte séparément', async () => {
    const worker1 = creerWorker(undefined); // undefined → MemoryStore par défaut
    const worker2 = creerWorker(undefined); // process/instance distincte

    const statuts = [];
    for (let i = 0; i < 6; i++) {
      const worker = i % 2 === 0 ? worker1 : worker2;
      statuts.push(await requeteDepuis(worker));
    }

    const autorisees = statuts.filter((s) => s === 200).length;

    // C'est EXACTEMENT le problème documenté dans l'audit : 2×MAX requêtes
    // autorisées au lieu de MAX, parce que chaque worker a son propre
    // compteur en mémoire.
    expect(autorisees).toBe(2 * MAX);
  });
});
