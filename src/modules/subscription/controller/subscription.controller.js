'use strict';

const SubscriptionService = require('../service/subscription.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, ForbiddenError } = require('../../../errors/AppError.js');

exports.getPlans = asyncHandler(async (req, res) => {
  const plans = SubscriptionService.getPlans();
  res.status(200).json({ success: true, message: 'Plans récupérés', data: { plans } });
});

exports.getStatus = asyncHandler(async (req, res) => {
  const result = await SubscriptionService.getStatus(req.user.organisationId);
  if (!result.success) throw new ForbiddenError(result.message);
  res.status(200).json({ success: true, message: 'Statut abonnement', data: result.status });
});

exports.getPlanDetails = asyncHandler(async (req, res) => {
  const result = await SubscriptionService.getPlanDetails(req.user.organisationId);
  if (!result.success) throw new ForbiddenError(result.message);
  res.status(200).json({ success: true, message: 'Détails du plan', data: result.data });
});

exports.creerPaymentIntent = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw new BadRequestError('Plan requis');

  const result = await SubscriptionService.creerPaymentIntent(req.user.organisationId, planId);
  if (!result.success) throw new BadRequestError(result.message);

  res.status(200).json({
    success: true,
    message: 'PaymentIntent créée',
    data: {
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      montant: result.montant,
      devise: result.devise,
    },
  });
});

exports.changerPlan = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) throw new BadRequestError('Plan requis');

  const result = await SubscriptionService.changerPlan(req.user.organisationId, planId);
  if (!result.success) throw new BadRequestError(result.message);

  res.status(200).json({
    success: true,
    message: 'PaymentIntent créée pour changement de plan',
    data: {
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      montant: result.montant,
      devise: result.devise,
    },
  });
});

exports.annulerAbonnement = asyncHandler(async (req, res) => {
  const result = await SubscriptionService.annulerAbonnement(req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);

  res.status(200).json({ success: true, message: result.message });
});

exports.webhook = asyncHandler(async (req, res) => {
  // Le body brut (octets exacts reçus) est requis : Stripe signe la charge utile
  // telle qu'envoyée. Re-sérialiser `req.body` produit un JSON compacté
  // différent (espaces, ordre des clés, échappements unicode) → signature
  // toujours invalide. `rawBodyMiddleware` + le hook `verify` posé sur
  // `express.json` renseignent `req.rawBody` ; les replis ci-dessous ne sont là
  // que pour les configurations dégradées (et sont alors signalés en log par le
  // middleware).
  const payload = req.rawBody
    || (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body));
  const signature = req.headers['stripe-signature'];

  if (!signature) throw new BadRequestError('Signature Stripe manquante');

  const result = await SubscriptionService.handleWebhook(payload, signature);
  if (!result.success) {
    const status = result.statusCode || 400;
    return res.status(status).json({ success: false, message: result.message });
  }

  res.status(200).json({ received: true });
});