'use strict';

/**
 * Classe de base pour toutes les erreurs métier de l'API.
 * isOperational = true  → erreur connue et attendue, message exposable au client
 * isOperational = false → bug inattendu, ne jamais exposer le détail au client
 */
class AppError extends Error {
  // `code` : identifiant stable et non traduit (ex: 'EMAIL_NON_VERIFIE'),
  // à l'usage des CLIENTS (web/mobile) pour brancher un comportement
  // spécifique SANS analyser le texte de `message` (qui, lui, peut changer
  // de formulation sans préavis — un couplage fragile, déjà observé : le
  // code 'SUBSCRIPTION_REQUIRED' était passé par checkSubscription.middleware.js
  // sans qu'aucune classe ne le stocke, donc jamais renvoyé au client).
  //
  // `details` : complément structuré (tableau de messages de validation, ou
  // objet de contexte). Il était lui aussi perdu : `checkSubscription` passait
  // `{ trialEnded, trialEndsAt }` en troisième argument de `ForbiddenError`,
  // qui n'en avait que deux.
  constructor(message, statusCode = 500, isOperational = true, code = null, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    if (details !== null && details !== undefined) this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Requête invalide', code = null, details = null) { super(message, 400, true, code, details); }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Non authentifié', code = null) { super(message, 401, true, code); }
}

class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé', code = null, details = null) { super(message, 403, true, code, details); }
}

class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable', code = null) { super(message, 404, true, code); }
}

class ConflictError extends AppError {
  constructor(message = 'Cette ressource existe déjà', code = null, details = null) { super(message, 409, true, code, details); }
}

/** Erreur de validation — peut porter des détails (tableau de messages Joi) */
class ValidationError extends AppError {
  constructor(message = 'Données invalides', details = []) {
    super(message, 422, true, null, details);
  }
}

/**
 * Une DÉPENDANCE ne répond pas (base, fournisseur d'e-mail, stockage…) —
 * 503 : la requête était correcte, elle peut être rejouée plus tard. Le
 * distinguer d'un 500 est ce qui permet au mobile de la remettre en file
 * d'attente au lieu de l'afficher comme un échec définitif.
 */
class ServiceIndisponibleError extends AppError {
  constructor(message = 'Service temporairement indisponible', code = 'SERVICE_INDISPONIBLE', details = null) {
    super(message, 503, true, code, details);
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
  ServiceIndisponibleError,
};
