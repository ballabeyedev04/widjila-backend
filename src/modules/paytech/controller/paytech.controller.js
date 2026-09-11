'use strict';

const PayTechService = require('../service/paytech.service.js');
const SubscriptionService = require('../../subscription/service/subscription.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const logger = require('../../../utils/logger.js');
const { BadRequestError, ForbiddenError } = require('../../../errors/AppError.js');

// La conversion EUR → XOF (parité fixe 655,957) vit dans
// `PayTechService.montantXof` : la demande de paiement et la vérification de
// l'IPN doivent calculer EXACTEMENT le même montant.

exports.createPayment = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw new BadRequestError('Plan requis');

  const organisationId = req.user.organisationId;
  if (!organisationId) throw new ForbiddenError('Organisation non trouvée');

  // Récupérer le plan pour le montant. `getPlans` est ASYNCHRONE (lecture du
  // catalogue en base) : non attendu, `plans.find` levait et la route
  // répondait 500 à chaque appel. La formule est désignée par son CODE —
  // c'est lui qui voyage dans `ref_command`, seule donnée signée de l'IPN.
  const plans = await SubscriptionService.getPlans();
  const plan = plans.find((p) => p.code === planId);
  if (!plan) throw new BadRequestError('Plan inconnu');
  const montant = PayTechService.montantXof(plan);
  if (montant === null) throw new BadRequestError('Cette formule ne peut pas être réglée en ligne');

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
  // Informatif seulement : l'IPN n'en tire plus rien (non signé par PayTech).
  const customField = PayTechService.encodeCustomField({ organisationId, planId });

  // Initier le paiement PayTech
  const result = await PayTechService.requestPayment({
    itemName: `Abonnement ${plan.nom}`,
    // Même calcul que la vérification de l'IPN (`montantXof`) : les deux
    // doivent tomber sur le même entier, sinon tout paiement serait refusé.
    itemPrice: montant,
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