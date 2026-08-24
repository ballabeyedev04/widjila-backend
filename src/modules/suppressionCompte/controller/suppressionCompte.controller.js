'use strict';

const SuppressionCompteService = require('../service/suppressionCompte.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { NotFoundError } = require('../../../errors/AppError.js');

/**
 * Dépôt d'une demande — PUBLIC, sans authentification.
 *
 * Réponse volontairement IDENTIQUE qu'il s'agisse d'une première demande ou
 * d'un doublon : distinguer les deux dirait à un visiteur anonyme si une
 * demande est déjà en cours pour une adresse donnée, ce qui renseigne sur
 * l'existence d'un compte. C'est la même précaution que sur l'oubli de mot
 * de passe.
 */
exports.creerDemande = asyncHandler(async (req, res) => {
  await SuppressionCompteService.creer(req.body, req.ip);
  res.status(201).json({
    success: true,
    message: 'Votre demande a bien été enregistrée. Nous vous répondrons sous 30 jours.',
  });
});

exports.listerDemandes = asyncHandler(async (req, res) => {
  const result = await SuppressionCompteService.lister(req.query);
  res.status(200).json({
    success: true,
    message: 'Demandes récupérées',
    data: { demandes: result.demandes, total: result.total },
  });
});

exports.compterEnAttente = asyncHandler(async (req, res) => {
  const result = await SuppressionCompteService.compterEnAttente();
  res.status(200).json({
    success: true,
    message: 'Compteur récupéré',
    data: { total: result.total },
  });
});

exports.traiterDemande = asyncHandler(async (req, res) => {
  const result = await SuppressionCompteService.traiter(req.params.id, req.body, req.user);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({
    success: true,
    message: result.message,
    data: { demande: result.demande },
  });
});
