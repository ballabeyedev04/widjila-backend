'use strict';

const DemandeInscriptionService = require('../service/demandeInscription.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

exports.listerDemandes = asyncHandler(async (req, res) => {
  const result = await DemandeInscriptionService.listDemandes(req.query);
  res.status(200).json({
    success: true,
    message: 'Demandes récupérées',
    data: { demandes: result.demandes, total: result.total },
  });
});

exports.compterEnAttente = asyncHandler(async (req, res) => {
  const result = await DemandeInscriptionService.compterEnAttente();
  res.status(200).json({
    success: true,
    message: 'Compteur récupéré',
    data: { total: result.total },
  });
});

exports.detailDemande = asyncHandler(async (req, res) => {
  const result = await DemandeInscriptionService.getDemande(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Demande récupérée', data: { demande: result.demande } });
});

exports.validerDemande = asyncHandler(async (req, res) => {
  const result = await DemandeInscriptionService.valider(req.params.id, req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { demande: result.demande } });
});

exports.rejeterDemande = asyncHandler(async (req, res) => {
  const result = await DemandeInscriptionService.rejeter(req.params.id, req.body, req.user, req.ip);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { demande: result.demande } });
});
