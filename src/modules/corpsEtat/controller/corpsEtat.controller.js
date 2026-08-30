'use strict';

const CorpsEtatService = require('../service/corpsEtat.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

/**
 * Corps d'état — catalogue des métiers / types de travaux du BTP.
 *
 * Le super-admin plateforme (`role: 'Admin'`) n'appartient à AUCUNE
 * organisation : c'est lui qui tient le catalogue STANDARD. Le drapeau dérive
 * donc du RÔLE, jamais d'un paramètre de requête — même règle que
 * `plan.controller.js#listerTousPlans`.
 */
const estSuperAdmin = (user) => user?.role === 'Admin';

/** `?actif=true|false` — absent = pas de filtre. */
const lireActif = (valeur) => {
  if (valeur === undefined || valeur === '') return undefined;
  return valeur === 'true' || valeur === true;
};

exports.lister = asyncHandler(async (req, res) => {
  const superAdmin = estSuperAdmin(req.user);
  const result = await CorpsEtatService.lister(
    req.user.organisationId,
    {
      // `req.query` est déjà plafonné par le middleware `paginate()` —
      // voir pagination.middleware.js.
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
      search: req.query.search,
      actif: lireActif(req.query.actif),
      organisationCible: req.query.organisationId,
    },
    { toutesOrganisations: superAdmin }
  );
  if (!result.success) throw new BadRequestError(result.message);

  res.status(200).json({
    success: true,
    message: 'Corps d’état récupérés',
    data: {
      corpsEtat: result.corpsEtat,
      pagination: { total: result.total, page: result.page, limit: result.limit },
    },
  });
});

/**
 * Liste des métiers ACTIFS, non paginée — c'est elle que consomment les
 * listes déroulantes du web et du mobile. Ouverte à tout membre authentifié :
 * choisir le corps d'état d'une réserve n'est pas une opération
 * d'administration.
 */
exports.listerActifs = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.listerActifs(req.user.organisationId);
  res.status(200).json({
    success: true,
    message: 'Corps d’état actifs récupérés',
    data: { corpsEtat: result.corpsEtat },
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.detail(
    req.user.organisationId,
    req.params.id,
    { toutesOrganisations: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Corps d’état récupéré', data: { corpsEtat: result.corpsEtat } });
});

/**
 * Répartition par phase des réserves d'un corps d'état — l'en-tête de l'écran
 * d'historique. Lecture ouverte à tout membre authentifié, comme le reste du
 * catalogue.
 */
exports.historique = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.historiqueParPhase(
    req.user.organisationId,
    req.params.id,
    { toutesOrganisations: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Historique récupéré',
    data: {
      corpsEtat: result.corpsEtat,
      repartition: result.repartition,
      total: result.total,
    },
  });
});

exports.creer = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.creer(
    req.user.organisationId,
    req.body,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { corpsEtat: result.corpsEtat } });
});

exports.modifier = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.modifier(
    req.user.organisationId,
    req.params.id,
    req.body,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { corpsEtat: result.corpsEtat } });
});

exports.basculerActif = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.basculerActif(
    req.user.organisationId,
    req.params.id,
    req.body.actif,
    { superAdmin: estSuperAdmin(req.user) }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { corpsEtat: result.corpsEtat } });
});

exports.supprimer = asyncHandler(async (req, res) => {
  const result = await CorpsEtatService.supprimer(
    req.user.organisationId,
    req.params.id,
    { superAdmin: estSuperAdmin(req.user) }
  );
  // `BadRequestError` : le refus le plus fréquent est « des réserves
  // l'utilisent », qui décrit un conflit d'état et porte un décompte — pas une
  // ressource absente.
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
