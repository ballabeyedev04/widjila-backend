'use strict';

const DashboardService = require('../service/dashboard.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const safeFilename = require('../../../utils/safeFilename.js');

exports.statsGlobales = asyncHandler(async (req, res) => {
  const result = await DashboardService.statsGlobales(req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Statistiques récupérées', data: { stats: result.stats } });
});

exports.statsChantier = asyncHandler(async (req, res) => {
  const result = await DashboardService.statsChantier(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Statistiques du chantier', data: { stats: result.stats } });
});

// -------------------- MODULE 9 — KPI avancés --------------------
exports.statsParEntreprise = asyncHandler(async (req, res) => {
  const result = await DashboardService.statsParEntreprise(req.user.organisationId);
  res.status(200).json({ success: true, message: 'Réserves par entreprise', data: { stats: result.stats } });
});

exports.statsParBatiment = asyncHandler(async (req, res) => {
  const result = await DashboardService.statsParBatiment(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Réserves par bâtiment', data: { stats: result.stats } });
});

exports.dureeTraitement = asyncHandler(async (req, res) => {
  const result = await DashboardService.dureeTraitement(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Délai de traitement', data: { stats: result.stats } });
});

exports.productivite = asyncHandler(async (req, res) => {
  const result = await DashboardService.productivite(req.user.organisationId, req.params.chantierId);
  res.status(200).json({ success: true, message: 'Productivité', data: { stats: result.stats } });
});

exports.evolution = asyncHandler(async (req, res) => {
  const result = await DashboardService.evolution(req.user.organisationId, req.params.chantierId);
  res.status(200).json({ success: true, message: 'Évolution', data: { stats: result.stats } });
});

exports.exportExcel = asyncHandler(async (req, res) => {
  const result = await DashboardService.exportExcel(req.user.organisationId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(result.filename)}"`);
  res.send(result.buffer);
});
