'use strict';

const redisClient = require('../config/redis.js');
const logger = require('./logger.js');

/**
 * Cache applicatif best-effort (audit — Charge à 10 000 utilisateurs §4).
 *
 * Sans Redis configuré (`REDIS_URL` absent), toutes les fonctions sont des
 * no-op silencieux : les appelants continuent de fonctionner exactement
 * comme avant (recalcul à chaque appel), juste sans mise en cache. Aucune
 * dépendance dure à Redis n'est introduite.
 *
 * Un échec Redis ponctuel (timeout, reconnexion) ne doit JAMAIS faire
 * échouer une requête métier : toute erreur est avalée et journalisée en
 * `debug`, avec un repli sur "pas de cache" pour cet appel.
 */

const lire = async (cle) => {
  if (!redisClient) return null;
  try {
    const brut = await redisClient.get(cle);
    return brut ? JSON.parse(brut) : null;
  } catch (err) {
    logger.debug(`[cache] lecture échouée pour ${cle}`, { error: err.message });
    return null;
  }
};

const ecrire = async (cle, valeur, ttlSecondes = 45) => {
  if (!redisClient) return;
  try {
    await redisClient.set(cle, JSON.stringify(valeur), 'EX', ttlSecondes);
  } catch (err) {
    logger.debug(`[cache] écriture échouée pour ${cle}`, { error: err.message });
  }
};

/** Invalide toutes les clés correspondant à un motif (ex: `dashboard:*:orgId`). */
const invalider = async (motif) => {
  if (!redisClient) return;
  try {
    const cles = await redisClient.keys(motif);
    if (cles.length) await redisClient.del(...cles);
  } catch (err) {
    logger.debug(`[cache] invalidation échouée pour ${motif}`, { error: err.message });
  }
};

module.exports = { lire, ecrire, invalider };
