'use strict';

const InspectionService = require('../service/inspection.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.creerInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.creerInspection(req.user.organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { inspection: result.inspection } });
});

exports.listerInspections = asyncHandler(async (req, res) => {
  const result = await InspectionService.listInspections(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Inspections récupérées',
    data: { inspections: result.inspections },
  });
});

exports.detailInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.getInspection(req.params.id, req.user.organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Inspection récupérée', data: { inspection: result.inspection } });
});

exports.modifierInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.modifierInspection(req.user.organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { inspection: result.inspection } });
});

exports.cocherChecklist = asyncHandler(async (req, res) => {
  const result = await InspectionService.cocherChecklist(
    req.user.organisationId,
    req.params.id,
    req.params.checklistId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { ligne: result.ligne } });
});

exports.supprimerInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.supprimerInspection(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
