'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * Exige que l'utilisateur authentifié appartienne à une organisation.
 *
 * Toutes les ressources métier (chantiers, réserves, plans, documents…) sont
 * rattachées à `organisationId`, repris de `req.user`. Deux comptes n'en ont
 * pas : le super-admin plateforme (`role: 'Admin'`, sans organisation par
 * conception — voir seeders/adminSeeder.js) et tout compte créé depuis la
 * plateforme sans organisation sélectionnée.
 *
 * Sans cette garde, la requête descendait jusqu'à `Model.create()` et
 * échouait sur la contrainte NOT NULL de la base : le client recevait un 422
 * « notNull Violation: Chantier.organisationId cannot be null » — un message
 * interne, qui ne dit pas quoi faire. On tranche ici, avec une consigne
 * exploitable par l'utilisateur.
 *
 * À placer APRÈS `auth`, sur les routes qui CRÉENT une ressource d'organisation.
 */
const requireOrganisation = (req, res, next) => {
  if (!req.user) return next(new ForbiddenError('Utilisateur non authentifié'));
  if (req.user.organisationId) return next();

  // Le super-admin plateforme passe : il DÉSIGNE l'organisation destinataire
  // dans sa requête (voir chantier.controller.js#creerChantier), qui produit
  // un message précis si elle manque. L'arrêter ici lui interdirait de créer
  // des chantiers pour ses clients — c'est pourtant son usage.
  if (req.user.role === 'Admin') return next();

  return next(new ForbiddenError(
    "Votre compte n'est rattaché à aucune organisation. Contactez l'administrateur de la plateforme pour qu'il vous en attribue une."
  ));
};

module.exports = requireOrganisation;
