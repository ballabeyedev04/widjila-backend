'use strict';

const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/security.js');
const User = require('../models/utilisateur.model.js');
const { UnauthorizedError, ForbiddenError, NotFoundError } = require('../errors/AppError.js');

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Token manquant ou invalide'));
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, jwtConfig.secret, { algorithms: ['HS256'] });

    // Le jeton de challenge MFA est signé avec CE MÊME secret (auth.service.js
    // _generateMfaToken) et porte `type: 'mfa'`. Sans ce contrôle, il valait
    // access token : un attaquant connaissant le mot de passe récupérait le
    // mfaToken renvoyé par /auth/login et accédait à tout sans jamais saisir
    // son code TOTP. Seul un jeton sans `type` est un access token.
    if (decoded.type) {
      return next(new UnauthorizedError('Token invalide pour cette opération'));
    }

    const utilisateur = await User.findByPk(decoded.id);
    if (!utilisateur) return next(new NotFoundError('Utilisateur introuvable'));

    // 'en_attente_validation' n'est PAS bloquant — seul 'inactif' l'est.
    if (utilisateur.statut === 'inactif') {
      return next(new ForbiddenError('Compte désactivé. Contactez le support.'));
    }

    req.user = utilisateur;
    next();
  } catch (err) {
    // TokenExpiredError / JsonWebTokenError → errorHandler
    next(err);
  }
};

module.exports = authMiddleware;
