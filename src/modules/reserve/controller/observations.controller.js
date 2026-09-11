'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const ObservationsService = require('../service/observations.service.js');

/**
 * `GET /reserves/observations` — observations déjà saisies par l'utilisateur,
 * pour les suggestions du champ « Observation » (voir observations.service.js).
 */
exports.listerObservationsUtilisees = asyncHandler(async (req, res) => {
  const result = await ObservationsService.listerObservationsUtilisees(req.user, req.query);
  res.status(200).json({
    success: true,
    message: 'Observations récupérées',
    data: { observations: result.observations },
  });
});
