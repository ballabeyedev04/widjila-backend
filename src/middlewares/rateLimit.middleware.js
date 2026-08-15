const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../config/redis.js');
const {
  authRateLimitConfig,
  mutationRateLimitConfig,
  adminRateLimitConfig,
  otpEmailRateLimitConfig,
  authenticatedRateLimitConfig,
} = require('../config/security.js');

/**
 * Store partagé (audit — Sécurité §3) : si REDIS_URL est configuré, TOUS les
 * limiteurs comptent dans le même Redis, quel que soit le worker PM2 qui
 * traite la requête — le mode cluster ne dilue plus la protection.
 *
 * Sans Redis, chaque limiteur retombe sur le `MemoryStore` par défaut
 * d'express-rate-limit (comportement historique, par process) : l'app reste
 * fonctionnelle en développement / déploiement mono-instance, seul le
 * comportement en cluster est différent (voir avertissement dans
 * config/redis.js).
 */
const sharedStore = (prefix) => {
  if (!redisClient) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // `call` (et non `sendCommand`) : signature attendue par rate-limit-redis
    // v6 pour un client ioredis.
    sendCommand: (...args) => redisClient.call(...args),
  });
};

// Auth routes (login, register, refresh) — 5 req / 15 min par IP
const authRateLimit = rateLimit({ ...authRateLimitConfig, store: sharedStore('auth') });

// Mutations sensibles (modifier profil, changer mdp) — 20 req / 15 min par IP
const mutationRateLimit = rateLimit({ ...mutationRateLimitConfig, store: sharedStore('mutation') });

// Routes admin — 200 req / 15 min par IP
const adminRateLimit = rateLimit({ ...adminRateLimitConfig, store: sharedStore('admin') });

// OTP forgot/reset par EMAIL — 3 req / 15 min par email ciblé (anti multi-IP)
// keyGenerator : normalise l'email reçu dans le body pour construire la clé de comptage
const otpEmailRateLimit = rateLimit({
  ...otpEmailRateLimitConfig,
  store: sharedStore('otp'),
  keyGenerator: (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    return email || ipKeyGenerator(req, res);
  },
  skip: (req) => {
    // Ne s'applique pas si le body est vide (le validate Joi rejettera la requête après)
    return !req.body?.email;
  },
});

// Routes authentifiées — 300 req / 15 min par UTILISATEUR (pas par IP).
// À placer APRÈS authMiddleware dans la chaîne, pour que req.user soit
// déjà disponible. Fallback sur l'IP si req.user est absent (comportement sûr).
const authenticatedRateLimit = rateLimit({
  ...authenticatedRateLimitConfig,
  store: sharedStore('authenticated'),
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
});

module.exports = { authRateLimit, mutationRateLimit, adminRateLimit, otpEmailRateLimit, authenticatedRateLimit };
