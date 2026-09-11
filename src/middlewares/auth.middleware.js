'use strict';

const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../config/security.js');
const User = require('../models/utilisateur.model.js');
const { UnauthorizedError, ForbiddenError } = require('../errors/AppError.js');

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

    // Compte supprimé (y compris en suppression logique) : 401 et non 404.
    // Un 404 n'était pas lu comme une fin de session par les clients — l'admin
    // restait « connecté » à un compte qui n'existe plus, chaque écran en
    // erreur (audit sécurité, déconnexion effective).
    const utilisateur = await User.findByPk(decoded.id);
    if (!utilisateur) return next(new UnauthorizedError('Session invalide, veuillez vous reconnecter'));

    // 'en_attente_validation' n'est PAS bloquant — seul 'inactif' l'est.
    if (utilisateur.statut === 'inactif') {
      return next(new ForbiddenError('Compte désactivé. Contactez le support.'));
    }

    // Version des tokens : un changement ou une réinitialisation de mot de
    // passe incrémente `token_version`, ce qui périme À L'INSTANT tous les
    // tokens d'accès déjà signés — y compris celui d'un attaquant, qui restait
    // sinon valable jusqu'à une heure après la reprise en main du compte.
    //
    // Aucune lecture supplémentaire : `utilisateur` vient d'être chargé
    // ci-dessus, la vérification est une comparaison d'entiers en mémoire.
    //
    // `?? 0` des DEUX côtés : les tokens signés AVANT le déploiement de ce
    // champ n'ont pas de `tv`. Les traiter comme la version 0 les laisse
    // vivre jusqu'à leur expiration naturelle, au lieu de déconnecter tout le
    // monde à la mise en production.
    if ((decoded.tv ?? 0) !== (utilisateur.token_version ?? 0)) {
      return next(new UnauthorizedError('Session expirée, veuillez vous reconnecter'));
    }

    req.user = utilisateur;
    next();
  } catch (err) {
    // TokenExpiredError / JsonWebTokenError → errorHandler
    next(err);
  }
};

module.exports = authMiddleware;
