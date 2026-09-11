const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../config/redis.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');
const {
  authRateLimitConfig,
  sessionRateLimitConfig,
  mutationRateLimitConfig,
  adminRateLimitConfig,
  otpEmailRateLimitConfig,
  authenticatedRateLimitConfig,
} = require('../config/security.js');

/**
 * Store Redis qui se RÉTABLIT après une indisponibilité au démarrage.
 *
 * CORRECTIF (panne en cascade Redis → authentification). `RedisStore` charge
 * ses scripts Lua une seule fois, dans `init()`, et garde la PROMESSE de leur
 * empreinte. Si Redis était injoignable à cet instant (redémarrage du
 * serveur Redis, démarrage de l'API avant lui dans docker compose), cette
 * promesse restait REJETÉE pour toujours : chaque `increment` la réattendait,
 * rejetait à nouveau, et la bibliothèque ne recharge le script que sur une
 * erreur `NOSCRIPT` — jamais sur celle-ci. Résultat : login, refresh,
 * logout, mot de passe oublié répondaient 500 jusqu'au redémarrage de l'API,
 * même longtemps après le retour de Redis. Reproduit par
 * `rateLimit.redisIndisponible.test.js`.
 *
 * Ici, après un échec, les scripts sont rechargés si leur chargement avait
 * échoué (au plus une tentative toutes les 2 s, pour ne pas marteler un
 * Redis en panne).
 */
class StoreRedisResilient extends RedisStore {
  async init(options) {
    this.windowMs = options.windowMs;
    this._chargerScripts();
    await Promise.all([this.incrementScriptSha, this.getScriptSha]);
  }

  async increment(cle) {
    try {
      return await super.increment(cle);
    } catch (err) {
      await this._apresEchec();
      throw err;
    }
  }

  async get(cle) {
    try {
      return await super.get(cle);
    } catch (err) {
      await this._apresEchec();
      throw err;
    }
  }

  _chargerScripts() {
    this._derniereTentative = Date.now();
    this.incrementScriptSha = this.loadIncrementScript();
    this.getScriptSha = this.loadGetScript();
    // Écouteurs posés sur les DEUX promesses : un rejet non écouté remonterait
    // en `unhandledRejection`, qui arrête le process.
    this._scriptsPrets = Promise.all([this.incrementScriptSha, this.getScriptSha]).then(() => true, () => false);
  }

  async _apresEchec() {
    if (await this._scriptsPrets) return; // scripts chargés : la panne est ailleurs (Redis coupé), rien à recharger
    if (Date.now() - this._derniereTentative < 2000) return;
    this._chargerScripts();
  }

  /** Appelé quand la connexion Redis (re)devient prête : recharge si le chargement avait échoué. */
  async rechargerSiNecessaire() {
    if (!(await this._scriptsPrets)) this._chargerScripts();
  }
}

/** Stores créés — rechargés dès que Redis redevient disponible. */
const storesRedis = new Set();

// Le client Redis n'accepte aucune commande avant d'être connecté
// (`enableOfflineQueue: false`, config/redis.js) : au démarrage, le
// chargement des scripts échoue donc presque toujours. On le relance dès que
// la connexion est prête, sans attendre qu'une requête échoue.
if (redisClient && typeof redisClient.on === 'function') {
  redisClient.on('ready', () => {
    for (const store of storesRedis) {
      store.rechargerSiNecessaire().catch((err) => {
        logger.warn('[rate-limit] Rechargement des scripts impossible', { error: err.message });
      });
    }
  });
}

/**
 * Journal des erreurs de store : une panne Redis ne doit ni bloquer les
 * requêtes, ni passer inaperçue.
 */
const journalStore = {
  error: (err, message) => {
    metrics.incrementer('rate_limit.erreur_store');
    logger.warn(`[rate-limit] ${message || 'erreur du store'}`, { error: err?.message || String(err) });
  },
  warn: (message) => logger.warn(`[rate-limit] ${message}`),
};

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
  const store = new StoreRedisResilient({
    prefix: `rl:${prefix}:`,
    // `call` (et non `sendCommand`) : signature attendue par rate-limit-redis
    // v6 pour un client ioredis.
    sendCommand: (...args) => redisClient.call(...args),
  });
  storesRedis.add(store);
  return store;
};

/**
 * Options communes aux limiteurs adossés à Redis.
 *
 * `passOnStoreError` : si Redis ne répond pas, la requête PASSE sans être
 * comptée (et l'incident est journalisé + compté). L'alternative — le
 * comportement par défaut — répondait 500 : une panne du cache devenait une
 * panne de l'authentification pour tous les utilisateurs. Le limiteur global
 * (mémoire, app.js) et le verrouillage de compte après échecs répétés
 * (auth.service.js, en base) restent actifs pendant la panne.
 */
const optionsStore = (prefixe) => {
  const store = sharedStore(prefixe);
  return store ? { store, passOnStoreError: true, logger: journalStore } : {};
};

// Tentatives d'AUTHENTIFICATION (login, register, mfa, mot de passe oublié)
// — 5 req / 15 min par IP. Compteur volontairement strict : ce sont les seules
// routes où un attaquant peut deviner un secret en réessayant.
const authRateLimit = rateLimit({ ...authRateLimitConfig, ...optionsStore('auth') });

// Cycle de vie de la SESSION (refresh, logout) — 60 req / 15 min par IP.
// Compteur SÉPARÉ (préfixe distinct) : sans quoi un rafraîchissement de jeton
// consommerait le budget des tentatives de connexion.
const sessionRateLimit = rateLimit({ ...sessionRateLimitConfig, ...optionsStore('session') });

// Mutations sensibles (modifier profil, changer mdp) — 20 req / 15 min par IP
const mutationRateLimit = rateLimit({ ...mutationRateLimitConfig, ...optionsStore('mutation') });

// Routes admin — 200 req / 15 min par IP
const adminRateLimit = rateLimit({ ...adminRateLimitConfig, ...optionsStore('admin') });

// OTP forgot/reset par EMAIL — 3 req / 15 min par email ciblé (anti multi-IP)
// keyGenerator : normalise l'email reçu dans le body pour construire la clé de comptage
const otpEmailRateLimit = rateLimit({
  ...otpEmailRateLimitConfig,
  ...optionsStore('otp'),
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

// Envoi de rapports par courriel — 10 envois / heure par UTILISATEUR.
// Chaque envoi part jusqu'à 100 destinataires (50 À + 50 Cc) sous l'adresse
// de la plateforme, avec objet et message libres : sans plafond dédié, seul le
// filet global (1000 req / 15 min / IP) bornait un usage en relais de spam ou
// d'hameçonnage. À placer APRÈS `auth`.
const envoiRapportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.ENVOI_RAPPORT_MAX_HEURE || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  store: sharedStore('envoi-rapport'),
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: require('../config/security.js').reponseLimite('Trop d’envois de rapports. Réessayez dans une heure.'),
});

module.exports = {
  authRateLimit, sessionRateLimit, mutationRateLimit,
  adminRateLimit, otpEmailRateLimit, authenticatedRateLimit,
  envoiRapportRateLimit,
  // Exportés pour les tests de résilience (rateLimit.redisIndisponible.test.js).
  StoreRedisResilient,
  journalStore,
};
