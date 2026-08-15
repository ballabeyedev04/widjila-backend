'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * Vérifie une permission fine sur le compte (RBAC + permissions JSON).
 * Modèle strict : aucun accès implicite. ['all'] = accès total.
 * null / [] = compte restreint tant qu'aucune permission n'est accordée.
 */
const requirePermission = (permission) => (req, res, next) => {
  const perms = req.user?.permissions;
  if (!Array.isArray(perms) || perms.length === 0) {
    return next(new ForbiddenError('Accès refusé : aucune permission définie pour ce compte.'));
  }
  if (perms.includes('all') || perms.includes(permission)) return next();
  return next(new ForbiddenError("Vous n'avez pas la permission d'accéder à cette ressource."));
};

module.exports = requirePermission;
