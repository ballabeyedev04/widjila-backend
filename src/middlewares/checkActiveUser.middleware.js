'use strict';

const { UnauthorizedError, ForbiddenError } = require('../errors/AppError.js');

const checkActiveUser = (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError('Utilisateur non authentifié'));
  // Seul 'actif' laisse passer. Un jeton émis avant un changement de statut
  // reste cryptographiquement valide jusqu'à son expiration : c'est ici, à
  // chaque requête, que la révocation prend effet (voir utilisateur.model.js).
  if (req.user.statut === 'en_attente_validation') {
    return next(new ForbiddenError("Votre demande d'inscription est en cours d'examen."));
  }
  if (req.user.statut === 'rejete') {
    return next(new ForbiddenError("Votre demande d'inscription a été refusée."));
  }
  if (req.user.statut !== 'actif') {
    return next(new ForbiddenError('Votre compte est désactivé. Veuillez contacter le support.'));
  }
  next();
};

module.exports = checkActiveUser;
