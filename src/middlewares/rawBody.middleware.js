'use strict';

const express = require('express');
const logger = require('../utils/logger.js');

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CAPTURE DU CORPS BRUT (rawBody) — requis par la vérification de signature
 * des webhooks Stripe (`stripe.webhooks.constructEvent`).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * CAUSE DU BUG CORRIGÉ
 * --------------------
 * `app.js` monte `express.json()` GLOBALEMENT (avant les routes). body-parser
 * consomme alors intégralement le flux de la requête et positionne `req._body
 * = true`. Quand le `express.raw()` de cette route s'exécutait ensuite, il
 * voyait `req._body` déjà vrai et sortait immédiatement sans rien lire :
 * `req.rawBody` restait `undefined`.
 *
 * Le contrôleur retombait donc sur `JSON.stringify(req.body)`, c'est-à-dire un
 * JSON RE-SÉRIALISÉ par Node : espaces, ordre des clés et échappements
 * unicode ne correspondent plus aux octets signés par Stripe. La signature
 * était donc TOUJOURS invalide → 400 sur chaque événement → aucun abonnement
 * ne s'activait jamais.
 *
 * Reproduction vérifiée (Express 5.2.1 / body-parser 2.3.0) sur une app
 * minimale reproduisant l'ordre de `app.js` :
 *   - corps envoyé      : {"id":"evt_1","type":"invoice.paid","spaces":   1}
 *   - JSON.stringify()  : {"id":"evt_1","type":"invoice.paid","spaces":1}
 *   → octets différents, HMAC différent, signature rejetée.
 *
 * POURQUOI LA CORRECTION EST ICI ET PAS DANS app.js
 * -------------------------------------------------
 * Une fois le flux consommé, il est IMPOSSIBLE de le relire : aucun middleware
 * monté sur la route ne peut récupérer les octets d'origine. La seule capture
 * possible se fait pendant la lecture, via l'option `verify` de body-parser,
 * qui reçoit le Buffer brut avant `JSON.parse`.
 *
 * Ce fichier n'a pas la main sur `app.js`, mais il est chargé AVANT lui :
 * `app.js` fait `require('./middlewares/rawBody.middleware.js')` à la ligne 17,
 * alors que `express.json({ limit: '512kb' })` n'est appelé qu'à la ligne 69.
 * On enveloppe donc `express.json` au chargement de ce module pour que
 * l'instance créée par `app.js` embarque automatiquement un hook `verify`.
 * `express.json` est une propriété de données writable/configurable dans
 * Express 5 — vérifié à l'exécution — donc l'enveloppe est sûre.
 *
 * ⚠️ DÉPENDANCE D'ORDRE : ce correctif suppose que `app.js` continue de
 * require-r ce module avant d'appeler `express.json()`. Si ce require
 * disparaît, `rawBodyMiddleware` émet un avertissement explicite en log (voir
 * plus bas) plutôt que d'échouer silencieusement. Le correctif « propre »
 * consiste à passer `verify` directement dans `app.js` (cf. `captureRawBody`,
 * exporté à cet effet).
 */

/**
 * Décide si les octets bruts doivent être conservés pour cette requête.
 * On ne garde pas le Buffer pour TOUT le trafic JSON : inutile de doubler
 * l'empreinte mémoire de chaque requête alors qu'un seul endpoint en a besoin.
 * Deux critères, volontairement redondants pour survivre à un changement de
 * chemin : présence d'un en-tête de signature, ou chemin de webhook.
 */
function besoinDeRawBody(req) {
  if (req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature'])) {
    return true;
  }
  const url = req.originalUrl || req.url || '';
  const chemin = url.split('?')[0];
  return chemin.endsWith('/webhook') || chemin.includes('/webhook/');
}

/**
 * Hook `verify` de body-parser : appelé avec le Buffer brut AVANT le parsing.
 * C'est le seul point où les octets d'origine sont encore disponibles.
 *
 * Signature body-parser : verify(req, res, buf, encoding). Toute exception
 * levée ici fait échouer le parsing du body avec un 403 — on encapsule donc
 * tout dans un try/catch pour ne jamais casser une requête légitime.
 */
function captureRawBody(req, res, buf, encoding) { // eslint-disable-line no-unused-vars
  try {
    if (buf && buf.length && besoinDeRawBody(req)) {
      // Copie défensive : body-parser peut réutiliser/concaténer ses buffers.
      req.rawBody = Buffer.from(buf);
    }
  } catch (err) {
    logger.warn(`[rawBody] Capture du corps brut impossible : ${err.message}`);
  }
}

/** Marqueur d'idempotence : évite un double enveloppement si le module est rechargé. */
const PATCH_FLAG = Symbol.for('suivichantier.rawBodyCapturePatched');

/**
 * Enveloppe `express.json` pour injecter le hook `verify` ci-dessus dans toute
 * instance créée par la suite (dont celle de `app.js`). Un `verify` fourni par
 * l'appelant est préservé et appelé après le nôtre.
 * @returns {boolean} true si l'enveloppement a bien été posé.
 */
function installerCaptureRawBody(mod = express) {
  if (!mod || mod[PATCH_FLAG]) return false;
  const jsonOriginal = mod.json;
  if (typeof jsonOriginal !== 'function') return false;

  const jsonEnveloppe = function json(options = {}) {
    const verifyAppelant = options.verify;
    return jsonOriginal({
      ...options,
      verify(req, res, buf, encoding) {
        captureRawBody(req, res, buf, encoding);
        if (typeof verifyAppelant === 'function') verifyAppelant(req, res, buf, encoding);
      },
    });
  };

  try {
    mod.json = jsonEnveloppe;
    mod[PATCH_FLAG] = true;
    return true;
  } catch (err) {
    logger.warn(`[rawBody] Impossible d'envelopper express.json : ${err.message}`);
    return false;
  }
}

const capturePosee = installerCaptureRawBody();

/** Parseur de repli : lit le flux tel quel s'il n'a PAS encore été consommé. */
const parseurBrut = express.raw({ type: '*/*', limit: '1mb' });

/**
 * Middleware à monter sur la route `/webhook`, AVANT tout autre middleware.
 *
 * Trois cas, du plus fréquent au plus dégradé :
 *  1. `req.rawBody` déjà présent (posé par le hook `verify`) → on passe.
 *  2. Flux non encore consommé (ex : Content-Type non JSON, ou `express.json`
 *     global retiré de `app.js`) → on lit nous-mêmes les octets bruts.
 *  3. Flux déjà consommé sans capture → on log un avertissement actionnable.
 *     Le contrôleur retombera sur le JSON re-sérialisé et Stripe rejettera la
 *     signature : mieux vaut un log explicite qu'un échec silencieux.
 */
function rawBodyMiddleware(req, res, next) {
  if (req.rawBody) return next();

  parseurBrut(req, res, (err) => {
    if (err) return next(err);

    // express.raw place les octets dans req.body quand il a réellement lu.
    if (Buffer.isBuffer(req.body) && req.body.length) {
      req.rawBody = req.body;
      return next();
    }

    logger.warn(
      '[rawBody] Corps brut indisponible sur ' + (req.originalUrl || req.url) +
      ' : le flux a déjà été consommé par un parseur en amont. ' +
      (capturePosee
        ? "Vérifier que app.js require bien 'middlewares/rawBody.middleware.js' AVANT d'appeler express.json()."
        : "L'enveloppe de express.json n'a pas pu être posée : passer { verify: captureRawBody } à express.json() dans app.js.") +
      ' La vérification de signature Stripe va échouer.'
    );
    next();
  });
}

/**
 * @deprecated NE PAS utiliser pour une vérification de signature.
 * Re-sérialiser `req.body` produit des octets différents de ceux signés par
 * l'émetteur (espaces, ordre des clés, échappements) : c'est précisément la
 * cause du bug corrigé ci-dessus. Conservé uniquement pour compatibilité
 * d'import ; utile seulement pour du log ou du debug.
 */
function attachRawBody(req, res, next) {
  if (req.body && !req.rawBody) {
    req.rawBody = JSON.stringify(req.body);
  }
  next();
}

module.exports = {
  rawBodyMiddleware,
  attachRawBody,
  captureRawBody,
  installerCaptureRawBody,
};
