'use strict';

const PlanService = require('../service/plan.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.uploaderPlan = asyncHandler(async (req, res) => {
  const data = { ...req.body, uploaderId: req.user.id };
  const result = await PlanService.upload(req.user.organisationId, req.params.chantierId, data, req.file);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.listerPlans = asyncHandler(async (req, res) => {
  const result = await PlanService.listPlans(req.user.organisationId, req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Plans récupérés', data: { plans: result.plans } });
});

exports.listerTousPlans = asyncHandler(async (req, res) => {
  const result = await PlanService.listTousPlans(req.user.organisationId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Plans récupérés', data: { plans: result.plans } });
});

exports.detailPlan = asyncHandler(async (req, res) => {
  const result = await PlanService.getPlan(req.params.id, req.user.organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Plan récupéré', data: { plan: result.plan } });
});

exports.supprimerPlan = asyncHandler(async (req, res) => {
  const result = await PlanService.supprimerPlan(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
