'use strict';

const PlanAbonnementService = require('../service/planAbonnement.service.js');
const SubscriptionService = require('../service/subscription.service.js');
const { AbonnementSouscrit, Organisation, PlanAbonnement } = require('../../../models/index.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { FONCTIONNALITES } = require('../../../config/fonctionnalites.js');

/**
 * Administration des formules — menu « Prix abonnements ».
 * Réservé au super-admin plateforme : la garde vit sur la route.
 */

exports.lister = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.lister();
  res.status(200).json({
    success: true,
    message: 'Formules récupérées',
    data: {
      plans: result.plans,
      // Le catalogue des fonctionnalités accompagne la liste : l'interface
      // d'administration doit pouvoir proposer des cases à cocher sans
      // recopier ces codes de son côté — une copie finirait par diverger.
      fonctionnalites: FONCTIONNALITES,
    },
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.detail(req.params.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Formule récupérée', data: { plan: result.plan } });
});

exports.creer = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.creer(req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.modifier = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.modifier(req.params.id, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.basculerActif = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.basculerActif(req.params.id, req.body.actif);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { plan: result.plan } });
});

exports.supprimer = asyncHandler(async (req, res) => {
  const result = await PlanAbonnementService.supprimer(req.params.id);
  // `BadRequestError` : le refus le plus fréquent est « des souscriptions
  // l'utilisent », qui décrit un conflit d'état et porte un décompte.
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

/**
 * Abonnements des clients — suivi par le super-admin.
 *
 * On expose ce qu'il faut pour SUIVRE (statut, échéance, prix réellement payé,
 * références de paiement), pas de quoi contourner le paiement : la seule
 * écriture possible est l'activation manuelle ci-dessous, tracée et motivée.
 */
exports.listerSouscriptions = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.organisationId) where.organisationId = req.query.organisationId;
  if (req.query.statut) where.statut = req.query.statut;

  // `req.query` est déjà plafonné par `paginate()`.
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;

  const { rows, count } = await AbonnementSouscrit.findAndCountAll({
    where,
    include: [
      { model: Organisation, as: 'organisation', attributes: ['id', 'nom', 'email'], required: false },
      { model: PlanAbonnement, as: 'plan', attributes: ['id', 'code', 'nom'], required: false },
    ],
    // `id` départage les lignes du même instant — pagination stable.
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });

  res.status(200).json({
    success: true,
    message: 'Souscriptions récupérées',
    data: {
      souscriptions: rows.map((s) => ({
        id: s.id,
        organisation: s.organisation
          ? { id: s.organisation.id, nom: s.organisation.nom, email: s.organisation.email }
          : null,
        planCode: s.plan_code,
        planNom: s.plan_nom,
        // Le prix RÉELLEMENT payé, figé à la souscription — il ne suit pas les
        // changements de tarif du catalogue.
        prixPaye: s.prix_paye === null ? null : Number(s.prix_paye),
        devise: s.devise,
        periode: s.periode,
        statut: s.statut,
        dateDebut: s.date_debut,
        dateFin: s.date_fin,
        fournisseur: s.fournisseur,
        referencePaiement: s.reference_paiement,
        stripeCustomerId: s.stripe_customer_id,
        stripeSubscriptionId: s.stripe_subscription_id,
        note: s.note,
        creeLe: s.createdAt,
      })),
      pagination: { total: count, page, limit },
    },
  });
});

/**
 * Activation manuelle — le cas « Entreprise, sur devis ».
 *
 * Contourne délibérément le paiement en ligne, ce qui en fait l'opération la
 * plus sensible du module : réservée au super-admin, tracée (`activee_par`,
 * `note`) et enregistrée dans l'historique au prix négocié.
 */
exports.activerManuellement = asyncHandler(async (req, res) => {
  const { organisationId, ...params } = req.body;
  const result = await SubscriptionService.activerManuellement(organisationId, params, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message });
});
