'use strict';

const DashboardService = require('../service/dashboard.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const safeFilename = require('../../../utils/safeFilename.js');
const { organisationCible, estSuperAdmin } = require('../../../utils/organisationRequete.js');

/**
 * Portée d'une statistique TRANSVERSALE (aucun chantier dans l'URL).
 *
 * Le super-admin plateforme n'appartient à aucune organisation : filtrer sur
 * la sienne ne remontait aucun chantier, et le tableau de bord s'affichait
 * « Aucune statistique » — sans erreur, sans rien dans les logs, puisque la
 * requête réussissait et renvoyait des compteurs à zéro. Il voit donc
 * l'ensemble des organisations, avec `?organisationId=` pour en cibler une.
 * Le drapeau dérive du RÔLE seul, jamais d'un paramètre client.
 */
function porteeTransversale(req) {
  const superAdmin = estSuperAdmin(req.user);
  return {
    organisationId: superAdmin ? (req.query.organisationId || null) : req.user.organisationId,
    // `auteur` : le tableau de bord doit compter ce que CE compte peut voir,
    // exactement comme la liste des chantiers.
    options: { toutesOrganisations: superAdmin, auteur: req.user },
  };
}

exports.statsGlobales = asyncHandler(async (req, res) => {
  const { organisationId, options } = porteeTransversale(req);
  const result = await DashboardService.statsGlobales(organisationId, options);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Statistiques récupérées', data: { stats: result.stats } });
});

exports.statsChantier = asyncHandler(async (req, res) => {
  // Statistique d'UN chantier : son organisation est celle du chantier visé.
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await DashboardService.statsChantier(organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Statistiques du chantier', data: { stats: result.stats } });
});

// -------------------- MODULE 9 — KPI avancés --------------------
exports.statsParEntreprise = asyncHandler(async (req, res) => {
  const { organisationId, options } = porteeTransversale(req);
  const result = await DashboardService.statsParEntreprise(organisationId, options);
  res.status(200).json({ success: true, message: 'Réserves par entreprise', data: { stats: result.stats } });
});

exports.statsParBatiment = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await DashboardService.statsParBatiment(organisationId, req.params.chantierId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Réserves par bâtiment', data: { stats: result.stats } });
});

exports.dureeTraitement = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await DashboardService.dureeTraitement(organisationId, req.params.chantierId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Délai de traitement', data: { stats: result.stats } });
});

exports.productivite = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
  const result = await DashboardService.productivite(organisationId, req.params.chantierId);
  res.status(200).json({ success: true, message: 'Productivité', data: { stats: result.stats } });
});

exports.evolution = asyncHandler(async (req, res) => {
  // Deux routes mènent ici : `/dashboard/evolution` (toute l'organisation, pas
  // de `:chantierId`) et `/dashboard/chantiers/:chantierId/evolution`.
  if (req.params.chantierId) {
    const organisationId = await organisationCible(req, { chantierId: req.params.chantierId });
    const result = await DashboardService.evolution(organisationId, req.params.chantierId);
    res.status(200).json({ success: true, message: 'Évolution', data: { stats: result.stats } });
    return;
  }

  const { organisationId, options } = porteeTransversale(req);
  const result = await DashboardService.evolution(organisationId, null, options);
  res.status(200).json({ success: true, message: 'Évolution', data: { stats: result.stats } });
});

exports.exportExcel = asyncHandler(async (req, res) => {
  const { organisationId, options } = porteeTransversale(req);
  const result = await DashboardService.exportExcel(organisationId, options);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(result.filename)}"`);
  res.send(result.buffer);
});
