'use strict';

const DevisService = require('../service/devis.service.js');
const SubscriptionService = require('../service/subscription.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');

/**
 * Devis d'abonnement — « Premium sur devis ».
 *
 * L'organisation vient TOUJOURS du jeton (`req.user.organisationId`), jamais
 * du corps ni de l'adresse : c'est ce qui cloisonne un devis à son
 * destinataire. Les routes d'administration, elles, sont gardées par le rôle
 * super-admin et n'ont pas besoin de ce cloisonnement.
 */

/** Traduit un refus du service en erreur HTTP, en gardant son code. */
function refus(result) {
  const Erreur = result.statusCode === 404 ? NotFoundError : BadRequestError;
  return new Erreur(result.message, result.code);
}

// ── Côté client ────────────────────────────────────────────────────────────

exports.demander = asyncHandler(async (req, res) => {
  const result = await DevisService.demander(
    req.user.organisationId, req.user.id, req.body
  );
  if (!result.success) throw refus(result);

  res.status(201).json({
    success: true,
    message: 'Demande de devis enregistrée. Nous revenons vers vous rapidement.',
    data: { devis: result.devis },
  });
});

exports.lister = asyncHandler(async (req, res) => {
  const result = await DevisService.lister(req.user.organisationId);
  res.status(200).json({ success: true, message: 'Devis récupérés', data: { devis: result.devis } });
});

exports.obtenir = asyncHandler(async (req, res) => {
  const result = await DevisService.obtenir(req.user.organisationId, req.params.id);
  if (!result.success) throw refus(result);
  res.status(200).json({ success: true, message: 'Devis récupéré', data: { devis: result.devis } });
});

exports.accepter = asyncHandler(async (req, res) => {
  const result = await DevisService.accepter(req.user.organisationId, req.params.id);
  if (!result.success) throw refus(result);
  res.status(200).json({ success: true, message: 'Devis accepté', data: { devis: result.devis } });
});

exports.refuser = asyncHandler(async (req, res) => {
  const result = await DevisService.refuser(
    req.user.organisationId, req.params.id, req.body.motif
  );
  if (!result.success) throw refus(result);
  res.status(200).json({ success: true, message: 'Devis refusé', data: { devis: result.devis } });
});

/**
 * Session de paiement du devis accepté.
 *
 * Rend l'adresse de la page Stripe. Aucun montant n'est accepté en entrée :
 * il est relu en base.
 */
exports.payer = asyncHandler(async (req, res) => {
  const result = await SubscriptionService.creerSessionDevis(
    req.user.organisationId, req.params.id, req.user.id
  );
  if (!result.success) throw refus(result);

  res.status(200).json({
    success: true,
    message: 'Session de paiement créée',
    data: {
      url: result.url,
      sessionId: result.sessionId,
      montant: result.montant,
      devise: result.devise,
      devis: result.devis,
    },
  });
});

// ── Côté administration (super-admin) ──────────────────────────────────────

exports.listerTout = asyncHandler(async (req, res) => {
  const result = await DevisService.listerTout({
    statut: req.query.statut,
    organisationId: req.query.organisationId,
    limit: req.pagination ? req.pagination.limit : undefined,
    offset: req.pagination ? req.pagination.offset : undefined,
  });

  res.status(200).json({
    success: true,
    message: 'Devis récupérés',
    data: { devis: result.devis, total: result.total },
  });
});

exports.preparer = asyncHandler(async (req, res) => {
  const result = await DevisService.preparer(req.params.id, req.user.id, req.body);
  if (!result.success) throw refus(result);
  res.status(200).json({ success: true, message: 'Devis chiffré', data: { devis: result.devis } });
});

exports.envoyer = asyncHandler(async (req, res) => {
  const result = await DevisService.envoyer(req.params.id, req.user.id);
  if (!result.success) throw refus(result);
  res.status(200).json({ success: true, message: 'Devis envoyé au client', data: { devis: result.devis } });
});
