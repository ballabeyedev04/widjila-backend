'use strict';

const PhaseReferentielService = require('../service/phaseReferentiel.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

/**
 * Référentiel des phases de chantier (Pré-cloisons, Cloisons, OPR…).
 *
 * Ne gère QUE les lignes de référentiel. Les phases de planning d'un chantier
 * restent servies par `chantier.controller.js` sur `/chantiers/:id/phases` —
 * voir `src/models/phase.model.js` pour la distinction.
 *
 * Le super-admin plateforme n'appartient à aucune organisation : c'est lui qui
 * tient le référentiel STANDARD. Le drapeau dérive du RÔLE, jamais d'un
 * paramètre de requête.
 */
const estSuperAdmin = (user) => user?.role === 'Admin';

/** `?actif=true|false` — absent = pas de filtre. */
const lireActif = (valeur) => {
  if (valeur === undefined || valeur === '') return undefined;
  return valeur === 'true' || valeur === true;
};

exports.lister = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.lister(
    req.user.organisationId,
    {
      // `req.query` est déjà plafonné par `paginate()`.
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      search: req.query.search,
      actif: lireActif(req.query.actif),
    },
    { toutesOrganisations: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);

  res.status(200).json({
    success: true,
    message: 'Phases récupérées',
    data: {
      phases: result.phases,
      pagination: { total: result.total, page: result.page, limit: result.limit },
    },
  });
});

/**
 * Phases ACTIVES, non paginées — c'est cette route que consomment les listes
 * déroulantes du web et du mobile. Ouverte à tout membre authentifié : choisir
 * la phase d'une réserve est un geste de terrain, pas d'administration.
 */
exports.listerActives = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.listerActives(req.user.organisationId);
  res.status(200).json({
    success: true,
    message: 'Phases actives récupérées',
    data: { phases: result.phases },
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.detail(
    req.user.organisationId,
    req.params.id,
    { toutesOrganisations: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Phase récupérée', data: { phase: result.phase } });
});

exports.creer = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.creer(
    req.user.organisationId,
    req.body,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.modifier = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.modifier(
    req.user.organisationId,
    req.params.id,
    req.body,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.basculerActif = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.basculerActif(
    req.user.organisationId,
    req.params.id,
    req.body.actif,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { phase: result.phase } });
});

exports.supprimer = asyncHandler(async (req, res) => {
  const result = await PhaseReferentielService.supprimer(
    req.user.organisationId,
    req.params.id,
    { superAdmin: estSuperAdmin(req.user) }
  );
  // `BadRequestError` : le refus le plus fréquent est « des réserves y sont
  // rattachées », qui décrit un conflit d'état et porte un décompte.
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
