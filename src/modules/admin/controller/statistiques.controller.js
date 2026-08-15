'use strict';

const StatistiquesService = require('../service/statistiques.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');

exports.statsPlateforme = asyncHandler(async (req, res) => {
  const result = await StatistiquesService.statsPlateforme();
  res.status(200).json({ success: true, message: 'Statistiques plateforme', data: result.stats });
});

exports.croissanceInscriptions = asyncHandler(async (req, res) => {
  const result = await StatistiquesService.croissanceInscriptions(req.query.mois || 6);
  res.status(200).json({ success: true, message: 'Croissance des inscriptions', data: result });
});
