'use strict';

const PayTechService = require('../service/paytech.service.js');
const SubscriptionService = require('../../subscription/service/subscription.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const logger = require('../../../utils/logger.js');
const { BadRequestError, ForbiddenError } = require('../../../errors/AppError.js');

/**
 * Taux de change fixe EUR → XOF (franc CFA d'Afrique de l'Ouest).
 * Le XOF a une parité FIXE avec l'euro depuis 1999 : 1 EUR = 655,957 XOF.
 * Ce n'est pas une approximation de marché, c'est une constante réglementaire.
 *
 * PayTech attend un montant en XOF, unité entière (pas de centimes : le franc
 * CFA n'a pas de subdivision en circulation).
 */
const TAUX_EUR_XOF = 655.957;

const eurosVersXof = (montantEuros) => Math.round(montantEuros * TAUX_EUR_XOF);

exports.createPayment = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw new BadRequestError('Plan requis');

  const organisationId = req.user.organisationId;
  if (!organisationId) throw new ForbiddenError('Organisation non trouvée');

  // Récupérer le plan pour le montant
  const plans = SubscriptionService.getPlans();
  const plan = plans.find(p => p.id === planId);
  if (!plan) throw new BadRequestError('Plan inconnu');

  // Vérifier si l'org a déjà un abonnement actif
  const status = await SubscriptionService.getStatus(organisationId);
  if (status.success && status.status.isSubscribed) {
    throw new BadRequestError('Vous avez déjà un abonnement actif');
  }

  // Vérifier que PayTech est configuré
  if (!PayTechService.isConfigured()) {
    throw new BadRequestError('Paiement PayTech non configuré sur le serveur');
  }

  // Générer une référence unique
  const refCommand = PayTechService.generateRefCommand(organisationId, planId);

  // Encoder les métadonnées dans custom_field
  const customField = PayTechService.encodeCustomField({
    organisationId,
    planId,
    priceId: plan.priceId,
  });

  // Initier le paiement PayTech
  const result = await PayTechService.requestPayment({
    itemName: `Abonnement ${plan.nom}`,
    itemPrice: eurosVersXof(plan.prix), // tarifs exprimés en EUR → converti en XOF
    refCommand,
    commandName: `Souscription au plan ${plan.nom} pour l'organisation ${req.user.organisation?.nom || organisationId}`,
  }, {
    targetPayment: 'Orange Money, Wave, Free Money',
    customField,
    successUrl: `${process.env.FRONTEND_URL}/abonnement?payment=success&ref=${refCommand}`,
    cancelUrl: `${process.env.FRONTEND_URL}/abonnement?payment=cancel&ref=${refCommand}`,
  });

  res.status(200).json({
    success: true,
    message: 'Paiement PayTech initié',
    data: {
      token: result.token,
      redirectUrl: result.redirectUrl,
      refCommand,
    },
  });
});

exports.ipn = asyncHandler(async (req, res) => {
  // PayTech envoie les données en application/x-www-form-urlencoded ou JSON
  const payload = req.body;

  logger.info('[paytech] IPN reçu:', { type_event: payload.type_event, ref_command: payload.ref_command });

  // Traiter l'IPN
  const result = await PayTechService.handlePaymentIpn(payload);

  // PayTech attend un 200 OK pour confirmer la réception
  if (result.success) {
    res.status(200).json({ received: true });
  } else {
    // Même en cas d'erreur métier, on répond 200 pour éviter les re-tentatives infinies
    // mais on log l'erreur
    res.status(200).json({ received: true, warning: result.message });
  }
});

exports.getPaymentStatus = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) throw new BadRequestError('Token requis');

  if (!PayTechService.isConfigured()) {
    throw new BadRequestError('PayTech non configuré');
  }

  const status = await PayTechService.getPaymentStatus(token);
  res.status(200).json({ success: true, data: status });
});

exports.verifyPayment = asyncHandler(async (req, res) => {
  // Vérification manuelle après retour utilisateur (success_url)
  const { token, ref } = req.query;
  if (!token && !ref) throw new BadRequestError('Token ou référence requis');

  if (!PayTechService.isConfigured()) {
    throw new BadRequestError('PayTech non configuré');
  }

  let paymentStatus;

  if (token) {
    paymentStatus = await PayTechService.getPaymentStatus(token);
  } else {
    // Si on a seulement la ref_command, on ne peut pas interroger PayTech directement
    // On vérifie le statut de l'abonnement côté serveur
    const organisationId = req.user.organisationId;
    const status = await SubscriptionService.getStatus(organisationId);
    if (!status.success) throw new ForbiddenError(status.message);

    paymentStatus = {
      success: status.status.isSubscribed,
      status: status.status.isSubscribed ? 'completed' : 'pending',
      ref_command: ref,
    };
  }

  res.status(200).json({ success: true, data: paymentStatus });
});