'use strict';

const HotspotService = require('../service/hotspot.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Comme les annotations, un hotspot tient son organisation de son plan
 * (hotspot → plan → chantier). `:id` désigne le plan, `:hotspotId` le repère —
 * voir utils/organisationRequete.js.
 */

exports.listerHotspots = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await HotspotService.lister(organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Repères récupérés',
    data: { hotspots: result.hotspots },
  });
});

exports.creerHotspot = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { planId: req.params.id });
  const result = await HotspotService.creer(organisationId, req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { hotspot: result.hotspot } });
});

exports.modifierHotspot = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { hotspotId: req.params.hotspotId });
  const result = await HotspotService.modifier(organisationId, req.params.hotspotId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { hotspot: result.hotspot } });
});

exports.supprimerHotspot = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { hotspotId: req.params.hotspotId });
  const result = await HotspotService.supprimer(organisationId, req.params.hotspotId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
