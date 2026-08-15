'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * Vérifie que l'utilisateur authentifié possède au moins un des rôles
 * autorisés. Le rôle 'Admin' (super-admin plateforme) a toujours accès.
 *
 * Usage :
 *   router.get('/', auth, requireRole('Admin', 'ChefProjet'), controller.lister);
 */
const requireRole = (...rolesAutorises) => (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ForbiddenError('Utilisateur non authentifié'));

  if (user.role === 'Admin') return next();
  if (rolesAutorises.includes(user.role)) return next();

  return next(new ForbiddenError("Vous n'avez pas les droits nécessaires pour cette action."));
};

module.exports = requireRole;
