'use strict';

/**
 * Classe de base pour toutes les erreurs métier de l'API.
 * isOperational = true  → erreur connue et attendue, message exposable au client
 * isOperational = false → bug inattendu, ne jamais exposer le détail au client
 */
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Requête invalide') { super(message, 400); }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Non authentifié') { super(message, 401); }
}

class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé') { super(message, 403); }
}

class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') { super(message, 404); }
}

class ConflictError extends AppError {
  constructor(message = 'Cette ressource existe déjà') { super(message, 409); }
}

/** Erreur de validation — peut porter des détails (tableau de messages Joi) */
class ValidationError extends AppError {
  constructor(message = 'Données invalides', details = []) {
    super(message, 422);
    this.details = details;
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
};
