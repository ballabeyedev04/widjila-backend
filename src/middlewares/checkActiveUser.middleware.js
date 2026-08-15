'use strict';

const { UnauthorizedError, ForbiddenError } = require('../errors/AppError.js');

const checkActiveUser = (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError('Utilisateur non authentifié'));
  // Seul le statut 'inactif' est bloquant (voir utilisateur.model.js).
  if (req.user.statut === 'inactif') {
    return next(new ForbiddenError('Votre compte est désactivé. Veuillez contacter le support.'));
  }
  next();
};

module.exports = checkActiveUser;
