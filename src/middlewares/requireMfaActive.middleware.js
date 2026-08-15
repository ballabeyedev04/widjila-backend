'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * MFA obligatoire pour le rôle super-admin plateforme (audit — Sécurité §3).
 *
 * Contexte : `req.user.role === 'Admin'` traverse `checkOrganisation` sans
 * aucun filtre — ce compte voit et modifie TOUTES les organisations
 * clientes, toutes les photos, toutes les données personnelles. Sa seule
 * protection au démarrage était une comparaison contre deux mots de passe
 * par défaut connus (voir `config/security.js`) : n'importe quel troisième
 * mauvais mot de passe passait. Une politique de mot de passe plus stricte
 * réduit le risque de compromission ; elle ne l'élimine pas (phishing,
 * réutilisation de mot de passe, poste compromis…). Le MFA est la couche
 * qui reste utile même quand le mot de passe a fuité.
 *
 * À poser APRÈS `auth`, `checkActiveUser` et `requireRole('Admin')` sur
 * chaque route `/admin/*` (super-admin plateforme) — jamais sur les routes
 * `/account/mfa/*` elles-mêmes, sous peine de verrouiller un admin qui n'a
 * pas encore activé son MFA hors de tout moyen de l'activer.
 */
const requireMfaActive = (req, res, next) => {
  if (req.user?.role !== 'Admin') return next(); // n'a rien à faire hors de ce rôle

  if (!req.user.mfa_active) {
    return next(new ForbiddenError(
      "L'authentification à deux facteurs (MFA) est obligatoire pour le rôle super-admin. "
      + 'Activez-la depuis votre profil (POST /account/mfa/provision puis /account/mfa/enable) avant de continuer.'
    ));
  }

  next();
};

module.exports = requireMfaActive;
