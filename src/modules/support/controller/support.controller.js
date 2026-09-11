'use strict';

const SupportService = require('../service/support.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { AppError } = require('../../../errors/AppError.js');

exports.envoyerMessage = asyncHandler(async (req, res) => {
  const result = await SupportService.envoyerMessage(req.user, req.body);
  // 503 / 502 et non 400 : le client n'a rien à corriger, c'est l'envoi qui
  // n'a pas pu se faire. Le message reste exposable (erreur opérationnelle).
  if (!result.success) throw new AppError(result.message, result.statut || 500, true);
  res.status(201).json({ success: true, message: result.message });
});
