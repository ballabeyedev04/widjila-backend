'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');
const SyncService = require('../service/sync.service.js');

/**
 * `GET /sync/reserves?curseur=&limite=` — voir `SyncService.deltaReserves`.
 *
 * L'organisation vient du JETON, jamais d'un paramètre : la synchronisation
 * sert le cache hors ligne d'un compte d'organisation. Le super-admin
 * plateforme n'en a pas — lui servir « toutes les organisations » viderait
 * la base entière dans un téléphone.
 */
exports.reserves = asyncHandler(async (req, res) => {
  if (!req.user.organisationId) {
    throw new BadRequestError('La synchronisation hors ligne est réservée aux comptes rattachés à une organisation.');
  }
  const result = await SyncService.deltaReserves(req.user.organisationId, req.user, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    data: {
      modifiees: result.modifiees,
      supprimees: result.supprimees,
      curseur: result.curseur,
      termine: result.termine,
    },
  });
});
