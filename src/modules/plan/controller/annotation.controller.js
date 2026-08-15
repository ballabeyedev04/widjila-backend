'use strict';

const AnnotationService = require('../service/annotation.service.js');
const PlanService = require('../service/plan.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.creerAnnotation = asyncHandler(async (req, res) => {
  const result = await AnnotationService.creerAnnotation(req.user.organisationId, req.params.id, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { annotation: result.annotation } });
});

exports.listerAnnotations = asyncHandler(async (req, res) => {
  const result = await AnnotationService.listAnnotations(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Annotations récupérées',
    data: { annotations: result.annotations },
  });
});

exports.modifierAnnotation = asyncHandler(async (req, res) => {
  const result = await AnnotationService.modifierAnnotation(req.user.organisationId, req.params.annotationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { annotation: result.annotation } });
});

exports.supprimerAnnotation = asyncHandler(async (req, res) => {
  const result = await AnnotationService.supprimerAnnotation(req.user.organisationId, req.params.annotationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// Comparaison de versions d'un plan (module 4)
exports.listerVersionsPlan = asyncHandler(async (req, res) => {
  const result = await PlanService.listVersions(req.user.organisationId, req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: 'Versions du plan récupérées',
    data: { plan: result.plan, versions: result.versions },
  });
});
