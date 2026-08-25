'use strict';

const InspectionService = require('../service/inspection.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Une inspection n'a pas d'`organisationId` : elle la tient de son chantier —
 * voir utils/organisationRequete.js. À la création, le chantier arrive dans le
 * corps de la requête ; ailleurs, `:id` désigne l'inspection.
 */
const orgDeInspection = (req) => organisationCible(req, { inspectionId: req.params.id });

exports.creerInspection = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.body.chantierId });
  const result = await InspectionService.creerInspection(organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { inspection: result.inspection } });
});

exports.listerInspections = asyncHandler(async (req, res) => {
  const result = await InspectionService.listInspections(await organisationCible(req, { chantierId: req.params.chantierId }), req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Inspections récupérées',
    data: { inspections: result.inspections },
  });
});

exports.detailInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.getInspection(req.params.id, await orgDeInspection(req));
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Inspection récupérée', data: { inspection: result.inspection } });
});

exports.modifierInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.modifierInspection(await orgDeInspection(req), req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { inspection: result.inspection } });
});

exports.cocherChecklist = asyncHandler(async (req, res) => {
  const result = await InspectionService.cocherChecklist(
    await orgDeInspection(req),
    req.params.id,
    req.params.checklistId,
    req.body
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { ligne: result.ligne } });
});

exports.supprimerInspection = asyncHandler(async (req, res) => {
  const result = await InspectionService.supprimerInspection(await orgDeInspection(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
