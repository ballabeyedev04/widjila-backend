'use strict';

const { ConnectionError: SequelizeConnectionError } = require('sequelize');
const { AppError } = require('../errors/AppError.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');
const masquerUrl = require('../utils/masquerUrl.js');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Gestionnaire d'erreurs centralisé Express (4 arguments obligatoires).
 * À monter EN DERNIER dans app.js, après toutes les routes.
 *
 * ── Format de réponse ───────────────────────────────────────────────────────
 *
 *   {
 *     success: false,
 *     message: string,            ← inchangé : lu par le web et le mobile
 *     code?:   string,            ← inchangé : présent seulement si l'erreur
 *                                   porte un code métier explicite (SUBSCRIPTION_*,
 *                                   ENVOI_EN_COURS…) — la synchronisation mobile
 *                                   classe ses reprises sur cette valeur
 *     details?: string[],         ← inchangé : messages de validation
 *     error: { code, message, details? },  ← NOUVEAU : format uniforme, code
 *                                   TOUJOURS renseigné (BASE_INDISPONIBLE,
 *                                   ROUTE_INTROUVABLE, ERREUR_INTERNE…)
 *     requestId: string           ← NOUVEAU : identifiant à citer au support,
 *                                   le même que dans les journaux serveur
 *   }
 *
 * Les champs historiques restent en place : les clients existants lisent
 * `message`, `code` et `details` au premier niveau, ils ne voient aucune
 * différence.
 *
 * Règle : aucun détail interne (stack, requête SQL, chemin) ne part au client en production.
 */

/** Code par défaut d'une erreur applicative sans code explicite. */
const CODE_PAR_STATUT = {
  400: 'REQUETE_INVALIDE',
  401: 'NON_AUTHENTIFIE',
  403: 'ACCES_REFUSE',
  404: 'RESSOURCE_INTROUVABLE',
  409: 'CONFLIT',
  413: 'CONTENU_TROP_VOLUMINEUX',
  422: 'DONNEES_INVALIDES',
  429: 'TROP_DE_REQUETES',
  503: 'SERVICE_INDISPONIBLE',
};

/**
 * Codes PostgreSQL qui traduisent une base INJOIGNABLE ou SURCHARGÉE, pas une
 * requête fautive : 57014 (délai de requête dépassé — statement_timeout),
 * 57P01/57P02/57P03 (serveur arrêté ou en démarrage), 53300 (trop de
 * connexions), classe 08 (connexion perdue).
 */
const CODES_PG_INDISPONIBLE = /^(57014|57P0[123]|53300|08\w{3})$/;

/**
 * La base n'est pas disponible — et la requête pourra réussir plus tard.
 *
 * CORRECTIF : seuls quatre noms d'erreurs étaient reconnus. Le plus fréquent
 * sous charge, `SequelizeConnectionAcquireTimeoutError` (pool épuisé), tombait
 * dans la branche fourre-tout et répondait 500 « Erreur interne » : le client
 * ne pouvait pas distinguer « réessayez » de « bug », et le mobile marquait
 * l'action hors ligne en échec au lieu de la retenter. Toutes les sous-classes
 * de `ConnectionError` (refus, hôte introuvable, délai d'acquisition…) sont
 * désormais des 503, de même que les requêtes annulées par délai.
 */
function estBaseIndisponible(err) {
  if (err instanceof SequelizeConnectionError) return true;
  if (typeof err.name === 'string' && /^Sequelize(Connection\w*|HostNot\w*|AccessDenied|InvalidConnection|Timeout)Error$/.test(err.name)) {
    return true;
  }
  const codePg = err.parent?.code || err.original?.code;
  return typeof codePg === 'string' && CODES_PG_INDISPONIBLE.test(codePg);
}

/**
 * Traduit n'importe quelle erreur en { statut, code, message, details, codeExplicite, retryAfterS }.
 * `codeExplicite` : le code vient de l'erreur elle-même (et part donc aussi
 * au premier niveau du corps, comme avant).
 */
function normaliser(err) {
  // ── AppError opérationnel (BadRequestError, NotFoundError, etc.) ─────────
  if (err instanceof AppError && err.isOperational) {
    const statut = err.statusCode;
    return {
      statut,
      code: err.code || CODE_PAR_STATUT[statut] || 'ERREUR',
      codeExplicite: Boolean(err.code),
      message: err.message,
      details: err.details,
      retryAfterS: statut === 503 ? (err.details?.reessayerDansS || 5) : null,
    };
  }

  // ── Erreurs JWT (jsonwebtoken) ───────────────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    return { statut: 401, code: 'TOKEN_EXPIRE', message: 'Token expiré' };
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return { statut: 401, code: 'TOKEN_INVALIDE', message: 'Token invalide' };
  }

  // ── Erreurs Multer ───────────────────────────────────────────────────────
  if (err.name === 'MulterError') {
    const tropGros = err.code === 'LIMIT_FILE_SIZE';
    return {
      statut: 400,
      code: tropGros ? 'FICHIER_TROP_VOLUMINEUX' : 'ENVOI_FICHIER_INVALIDE',
      message: tropGros ? 'Fichier trop volumineux (max 5 MB)' : "Erreur lors de l'envoi du fichier",
    };
  }

  // ── JSON malformé dans le body ───────────────────────────────────────────
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return { statut: 400, code: 'JSON_INVALIDE', message: 'Corps de requête JSON invalide' };
  }

  // ── Erreurs Sequelize ────────────────────────────────────────────────────
  if (err.name === 'SequelizeValidationError') {
    return {
      statut: 422,
      code: 'DONNEES_INVALIDES',
      message: 'Données invalides',
      details: isProd ? undefined : err.errors?.map((e) => e.message),
    };
  }
  if (err.name === 'SequelizeUniqueConstraintError') {
    return { statut: 409, code: 'RESSOURCE_EXISTANTE', message: 'Cette ressource existe déjà' };
  }
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return { statut: 400, code: 'REFERENCE_INVALIDE', message: 'Référence invalide : ressource liée introuvable' };
  }
  // Identifiant malformé — typiquement un `:id` qui n'est pas un UUID.
  //
  // PostgreSQL rejette la valeur (« invalid input syntax for type uuid ») et
  // Sequelize remonte une `SequelizeDatabaseError`. Ce n'est PAS une panne :
  // c'est une requête qui désigne une ressource qui ne peut pas exister. La
  // traiter en 500 déclenchait une alerte de supervision pour une faute
  // d'URL, faisait afficher « erreur interne » au lieu de « introuvable », et
  // laissait fuir le détail SQL hors production.
  //
  // Seul ce cas précis est reclassé : toute autre `SequelizeDatabaseError`
  // (colonne absente, contrainte, schéma périmé) reste un vrai 500, car c'est
  // bien le serveur qui est en tort.
  if (err.name === 'SequelizeDatabaseError' && /invalid input syntax for type uuid/i.test(err.message || '')) {
    return { statut: 404, code: 'RESSOURCE_INTROUVABLE', message: 'Ressource introuvable' };
  }

  if (estBaseIndisponible(err)) {
    return {
      statut: 503,
      code: 'BASE_INDISPONIBLE',
      message: 'Service temporairement indisponible',
      retryAfterS: 5,
    };
  }

  // ── Limite de corps JSON dépassée (express.json limit) ──────────────────
  if (err.status === 413 || err.type === 'entity.too.large') {
    return { statut: 413, code: 'CONTENU_TROP_VOLUMINEUX', message: 'Corps de la requête trop volumineux (max 512 KB)' };
  }

  // ── Tout le reste → 500, détails masqués en production ─────────────────
  return {
    statut: 500,
    code: 'ERREUR_INTERNE',
    message: isProd ? 'Erreur interne du serveur' : (err.message || 'Erreur interne du serveur'),
  };
}

/**
 * Niveau de journal selon la gravité.
 *
 * Tout était écrit en `error`, 401 et 404 compris : le fichier error.log se
 * remplissait de sessions expirées et de fautes d'URL, et une alerte sur
 * « lignes d'erreur » aurait sonné en continu. Désormais : 5xx en `error`
 * (avec la pile), refus de droits en `warn`, simples erreurs client en `info`.
 */
function niveau(statut) {
  if (statut >= 500) return 'error';
  if (statut === 403 || statut === 413 || statut === 429) return 'warn';
  return 'info';
}

const errorHandler = (err, req, res, next) => {
  const erreur = normaliser(err);
  const requestId = req.id;

  metrics.enregistrerErreur(erreur.code);

  // ── Journal serveur : QUOI, QUI, QUELLE REQUÊTE, QUELLE ÉTAPE ────────────
  const contexte = {
    requestId,
    statut: erreur.statut,
    code: erreur.code,
    methode: req.method,
    // Motif de la route SANS son préfixe de montage : Express a déjà restauré
    // `req.baseUrl` quand l'erreur sort du routeur. Le chemin complet suit.
    motifRoute: req.route?.path,
    chemin: masquerUrl(req.originalUrl || req.path),
    utilisateurId: req.user?.id,
    organisationId: req.user?.organisationId,
    ip: req.ip,
    erreur: err.name,
  };
  if (erreur.statut >= 500) {
    contexte.stack = err.stack;
    // Cause SQL (code PostgreSQL, contrainte) : c'est elle qui dit QUELLE
    // étape a échoué. Jamais renvoyée au client.
    const cause = err.parent || err.original;
    if (cause) contexte.causeSql = { code: cause.code, message: cause.message };
  }
  logger.log(niveau(erreur.statut), err.message || erreur.message, contexte);

  // Réponse déjà partiellement envoyée (flux de fichier coupé en cours de
  // route) : impossible d'écrire un corps JSON. Express referme la connexion.
  if (res.headersSent) return next(err);

  const corps = { success: false, message: erreur.message };
  if (Array.isArray(erreur.details) && erreur.details.length) corps.details = erreur.details;
  if (erreur.codeExplicite) corps.code = erreur.code;
  corps.error = {
    code: erreur.code,
    message: erreur.message,
    ...(erreur.details !== undefined && erreur.details !== null ? { details: erreur.details } : {}),
  };
  if (requestId) corps.requestId = requestId;

  if (erreur.retryAfterS) res.setHeader('Retry-After', String(erreur.retryAfterS));
  return res.status(erreur.statut).json(corps);
};

module.exports = errorHandler;
module.exports.normaliser = normaliser;
module.exports.estBaseIndisponible = estBaseIndisponible;
