'use strict';

const { AppError } = require('../errors/AppError.js');
const logger = require('../utils/logger.js');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Gestionnaire d'erreurs centralisé Express (4 arguments obligatoires).
 * À monter EN DERNIER dans app.js, après toutes les routes.
 *
 * Format de réponse uniforme :
 *   { success: false, message: string, details?: string[] }
 *
 * Règle : aucun détail interne (stack, requête SQL, chemin) ne part au client en production.
 */
const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  // ── Log serveur complet (stack, contexte) ──────────────────────────────────
  logger.error(err.message, {
    name:       err.name,
    statusCode: err.statusCode,
    path:       req.path,
    method:     req.method,
    ip:         req.ip,
    stack:      err.stack,
  });

  // ── AppError opérationnel (BadRequestError, NotFoundError, etc.) ───────────
  if (err instanceof AppError && err.isOperational) {
    const body = { success: false, message: err.message };
    if (err.details && err.details.length) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  // ── Erreurs JWT (jsonwebtoken) ─────────────────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expiré' });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return res.status(401).json({ success: false, message: 'Token invalide' });
  }

  // ── Erreurs Multer ─────────────────────────────────────────────────────────
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Fichier trop volumineux (max 5 MB)'
      : "Erreur lors de l'envoi du fichier";
    return res.status(400).json({ success: false, message });
  }

  // ── JSON malformé dans le body ─────────────────────────────────────────────
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ success: false, message: 'Corps de requête JSON invalide' });
  }

  // ── Erreurs Sequelize ──────────────────────────────────────────────────────
  if (err.name === 'SequelizeValidationError') {
    return res.status(422).json({
      success: false,
      message: 'Données invalides',
      ...(isProd ? {} : { details: err.errors?.map((e) => e.message) }),
    });
  }
  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ success: false, message: 'Cette ressource existe déjà' });
  }
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({ success: false, message: 'Référence invalide : ressource liée introuvable' });
  }
  if (
    err.name === 'SequelizeConnectionError' ||
    err.name === 'SequelizeConnectionRefusedError' ||
    err.name === 'SequelizeConnectionTimedOutError' ||
    err.name === 'SequelizeTimeoutError'
  ) {
    return res.status(503).json({ success: false, message: 'Service temporairement indisponible' });
  }

  // ── Limite de corps JSON dépassée (express.json limit) ────────────────────
  if (err.status === 413 || err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Corps de la requête trop volumineux (max 512 KB)' });
  }

  // ── Tout le reste → 500, détails masqués en production ───────────────────
  const message = isProd ? 'Erreur interne du serveur' : (err.message || 'Erreur interne du serveur');
  return res.status(500).json({ success: false, message });
};

module.exports = errorHandler;
