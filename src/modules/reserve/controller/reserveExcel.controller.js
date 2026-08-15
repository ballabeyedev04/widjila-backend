'use strict';

const ReserveExcelService = require('../service/reserveExcel.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const safeFilename = require('../../../utils/safeFilename.js');

// -------------------- EXPORT EXCEL --------------------
exports.exporterExcel = asyncHandler(async (req, res) => {
  const result = await ReserveExcelService.exporterExcel(req.user.organisationId, req.params.chantierId, req.query);
  if (!result.success) throw new NotFoundError(result.message);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(result.filename)}"`);
  res.send(result.buffer);
});

// -------------------- IMPORT EXCEL --------------------
exports.importerExcel = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) throw new BadRequestError('Fichier Excel manquant');
  const result = await ReserveExcelService.importerExcel(
    req.user.organisationId,
    req.params.chantierId,
    req.file.buffer,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { results: result.results } });
});
