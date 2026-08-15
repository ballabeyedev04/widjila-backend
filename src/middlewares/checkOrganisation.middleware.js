'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * Isolation multi-tenant : s'assure qu'une ressource (chantier, réserve…)
 * appartient bien à l'organisation de l'utilisateur connecté.
 *
 * À utiliser APRÈS auth et checkActiveUser, sur les routes qui accèdent à
 * une ressource par id :
 *   router.get('/:id', auth, checkActiveUser, checkOrganisation('Chantier', 'chantierId'), controller.detail);
 *
 * La ressource est chargée et attachée à req.resource pour éviter un double fetch.
 */
const checkOrganisation = (model, whereKey) => async (req, res, next) => {
  try {
    const resourceId = req.params.id || req.params[whereKey];
    if (!resourceId) return next();

    const resource = await model.findByPk(resourceId);
    if (!resource) {
      const { NotFoundError } = require('../errors/AppError.js');
      return next(new NotFoundError('Ressource introuvable'));
    }

    // Super-admin : accès à tout
    if (req.user.role === 'Admin') {
      req.resource = resource;
      return next();
    }

    const organisationId = resource[whereKey];
    if (!organisationId) {
      req.resource = resource;
      return next();
    }

    if (String(organisationId) !== String(req.user.organisationId)) {
      return next(new ForbiddenError('Accès refusé : cette ressource appartient à une autre organisation.'));
    }

    req.resource = resource;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = checkOrganisation;
