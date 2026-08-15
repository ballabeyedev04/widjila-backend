'use strict';

const Stripe = require('stripe');
const { Organisation } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');

/**
 * Client Stripe initialisé PARESSEUSEMENT.
 *
 * Le constructeur Stripe lève « Neither apiKey nor config.authenticator
 * provided » quand la clé est vide. Instancié au chargement du module, il
 * faisait donc échouer le démarrage complet de l'API sur toute installation
 * sans Stripe configuré — typiquement un déploiement PayTech seul.
 *
 * Même stratégie que le client Resend (infrastructure/emailService.js) :
 * l'application démarre, et seules les routes de paiement carte signalent
 * l'absence de configuration.
 */
let stripeClient = null;
let stripeInitialise = false;

function getStripe() {
  if (stripeInitialise) return stripeClient;
  stripeInitialise = true;

  if (!process.env.STRIPE_SECRET_KEY) {
    logger.warn('[stripe] STRIPE_SECRET_KEY non définie — paiements par carte désactivés');
    return null;
  }
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

/** Client Stripe garanti non nul, sinon erreur métier explicite. */
function requireStripe() {
  const client = getStripe();
  if (!client) {
    throw new Error('Paiement par carte indisponible : Stripe n’est pas configuré sur le serveur.');
  }
  return client;
}

// Plans disponibles (doivent correspondre aux Price ID Stripe en env)
const PLANS = {
  starter: {
    id: 'starter',
    nom: 'Starter',
    prix: 29,
    devise: 'EUR',
    description: 'Pour les petites équipes — 5 chantiers, 10 utilisateurs',
    features: [
      'Jusqu\'à 5 chantiers',
      'Jusqu\'à 10 utilisateurs',
      'Réserves & inspections',
      'Support par email',
    ],
    priceId: process.env.STRIPE_PRICE_STARTER || 'price_starter',
    limiteChantiers: 5,
    limiteUtilisateurs: 10,
  },
  pro: {
    id: 'pro',
    nom: 'Pro',
    prix: 79,
    devise: 'EUR',
    description: 'Pour les PME — chantiers illimités, 50 utilisateurs',
    features: [
      'Chantiers illimités',
      'Jusqu\'à 50 utilisateurs',
      'Plans & documents',
      'Tableaux de bord avancés',
      'Support prioritaire',
    ],
    priceId: process.env.STRIPE_PRICE_PRO || 'price_pro',
    limiteChantiers: -1,
    limiteUtilisateurs: 50,
  },
  business: {
    id: 'business',
    nom: 'Business',
    prix: 199,
    devise: 'EUR',
    description: 'Pour les grandes entreprises — utilisateurs illimités, multi-agences',
    features: [
      'Tout du plan Pro',
      'Utilisateurs illimités',
      'Filiales & agences',
      'API & intégrations',
      'Support dédié 24/7',
    ],
    priceId: process.env.STRIPE_PRICE_BUSINESS || 'price_business',
    limiteChantiers: -1,
    limiteUtilisateurs: -1,
  },
};

class SubscriptionService {

  /** Liste des plans disponibles (pour la page d'abonnement). */
  static getPlans() {
    return Object.values(PLANS).map((p) => ({
      id: p.id,
      nom: p.nom,
      prix: p.prix,
      devise: p.devise,
      description: p.description,
      features: p.features,
      limiteChantiers: p.limiteChantiers,
      limiteUtilisateurs: p.limiteUtilisateurs,
    }));
  }

  /** Récupère le statut d'abonnement complet d'une organisation. */
  static async getStatus(organisationId) {
    const org = await Organisation.findByPk(organisationId, {
      attributes: [
        'id', 'nom', 'is_subscribed', 'trial_ends_at', 'abonnement',
        'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id',
      ],
    });
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const now = new Date();
    const trialEnded = org.trial_ends_at && new Date(org.trial_ends_at) < now;
    const joursRestants = org.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(org.trial_ends_at) - now) / (1000 * 60 * 60 * 24)))
      : 0;

    return {
      success: true,
      status: {
        isSubscribed: org.is_subscribed,
        trialEnded,
        joursRestantsTrial: joursRestants,
        trialEndsAt: org.trial_ends_at,
        planActuel: org.abonnement,
        stripeCustomerId: org.stripe_customer_id,
        stripeSubscriptionId: org.stripe_subscription_id,
      },
    };
  }

  /**
   * Crée une PaymentIntent Stripe pour un plan donné.
   * Le montant est calculé côté serveur (jamais depuis le client).
   * Le card data ne transite JAMAIS par le backend (PCI-DSS).
   */
  static async creerPaymentIntent(organisationId, planId) {
    const plan = PLANS[planId];
    if (!plan) return { success: false, message: 'Plan inconnu' };

    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const stripe = requireStripe();

    // Récupérer ou créer le client Stripe
    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: org.email || undefined,
        name: org.nom,
        metadata: { organisationId: org.id },
      });
      customerId = customer.id;
      await org.update({ stripe_customer_id: customerId });
    }

    // Créer la PaymentIntent (montant en centimes)
    const amount = Math.round(plan.prix * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      // `devise` — l'ancien `plan.device` était une faute de frappe : toujours
      // undefined, donc toute devise autre que l'euro aurait été facturée en EUR.
      currency: plan.devise ?? 'eur',
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        organisationId: org.id,
        planId: plan.id,
        priceId: plan.priceId,
      },
    });

    return {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      montant: amount,
      devise: plan.devise,
    };
  }

  /**
   * Traite un événement webhook Stripe (payment_intent.succeeded, etc.).
   * Vérifie la signature (obligatoire) puis active l'abonnement.
   */
  static async handleWebhook(payload, signature) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!endpointSecret) {
      logger.error('[stripe] STRIPE_WEBHOOK_SECRET non configuré');
      return { success: false, message: 'Webhook non configuré' };
    }

    const stripe = getStripe();
    if (!stripe) {
      logger.error('[stripe] Webhook reçu mais STRIPE_SECRET_KEY non configurée');
      return { success: false, message: 'Stripe non configuré' };
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, endpointSecret);
    } catch (err) {
      logger.warn(`[stripe] Signature webhook invalide : ${err.message}`);
      return { success: false, message: 'Signature invalide', statusCode: 400 };
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const organisationId = pi.metadata?.organisationId;
        const planId = pi.metadata?.planId;
        if (!organisationId) {
          logger.warn('[stripe] payment_intent.succeeded sans organisationId');
          break;
        }
        await SubscriptionService._activerAbonnement(
          organisationId,
          planId,
          pi.metadata?.priceId,
          pi.customer
        );
        break;
      }
      case 'payment_intent.payment_failed': {
        logger.warn(`[stripe] Paiement échoué : ${event.data.object.id}`);
        break;
      }
      case 'invoice.paid': {
        // Renouvellement d'abonnement
        const orgId = event.data.object.metadata?.organisationId;
        if (orgId) {
          await SubscriptionService._activerAbonnement(
            orgId,
            event.data.object.metadata?.planId,
            event.data.object.metadata?.priceId,
            event.data.object.customer
          );
        }
        break;
      }
      default:
        logger.info(`[stripe] Événement non géré : ${event.type}`);
    }

    return { success: true, received: true };
  }

  /** Active l'abonnement d'une organisation. */
  static async _activerAbonnement(organisationId, planId, priceId, stripeCustomerId) {
    const org = await Organisation.findByPk(organisationId);
    if (!org) {
      logger.warn(`[stripe] Org introuvable pour activation : ${organisationId}`);
      return;
    }

    const plan = planId ? PLANS[planId] : null;
    await org.update({
      is_subscribed: true,
      abonnement: plan ? plan.nom : org.abonnement,
      stripe_subscription_id: org.stripe_subscription_id || stripeCustomerId,
      stripe_price_id: priceId || org.stripe_price_id,
      stripe_customer_id: stripeCustomerId || org.stripe_customer_id,
    });

    logger.info(`[stripe] Abonnement activé pour ${organisationId} (plan: ${planId || 'n/a'})`);
  }

  /** Annule l'abonnement (remet en trial expiré). */
  static async annulerAbonnement(organisationId) {
    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    await org.update({
      is_subscribed: false,
      trial_ends_at: new Date(Date.now() - 1000), // déjà expiré
    });

    return { success: true, message: 'Abonnement annulé' };
  }

  /**
   * Change le plan d'abonnement d'une organisation.
   * Crée un nouveau PaymentIntent pour le nouveau plan.
   * Le changement prend effet après paiement réussi (via webhook).
   */
  static async changerPlan(organisationId, planId) {
    const plan = PLANS[planId];
    if (!plan) return { success: false, message: 'Plan inconnu' };

    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    // Si l'org n'est pas abonnée, on traite comme nouvelle souscription
    if (!org.is_subscribed) {
      return await SubscriptionService.creerPaymentIntent(organisationId, planId);
    }

    // Pour un changement de plan, on crée un PaymentIntent pour le nouveau montant
    // Le webhook mettra à jour l'abonnement après paiement
    return await SubscriptionService.creerPaymentIntent(organisationId, planId);
  }

  /**
   * Récupère le plan actuel et les détails de l'abonnement.
   */
  static async getPlanDetails(organisationId) {
    const org = await Organisation.findByPk(organisationId, {
      attributes: [
        'id', 'nom', 'is_subscribed', 'trial_ends_at', 'abonnement',
        'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id',
      ],
    });
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const currentPlan = PLANS[org.abonnement?.toLowerCase?.() || ''];
    const now = new Date();
    const trialEnded = org.trial_ends_at && new Date(org.trial_ends_at) < now;
    const joursRestants = org.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(org.trial_ends_at) - now) / (1000 * 60 * 60 * 24)))
      : 0;

    return {
      success: true,
      data: {
        isSubscribed: org.is_subscribed,
        trialEnded,
        joursRestantsTrial: joursRestants,
        trialEndsAt: org.trial_ends_at,
        planActuel: org.abonnement,
        planActuelDetails: currentPlan ? {
          id: currentPlan.id,
          nom: currentPlan.nom,
          prix: currentPlan.prix,
          devise: currentPlan.devise,
          features: currentPlan.features,
          limiteChantiers: currentPlan.limiteChantiers,
          limiteUtilisateurs: currentPlan.limiteUtilisateurs,
        } : null,
        stripeCustomerId: org.stripe_customer_id,
        stripeSubscriptionId: org.stripe_subscription_id,
        stripePriceId: org.stripe_price_id,
        allPlans: Object.values(PLANS).map(p => ({
          id: p.id,
          nom: p.nom,
          prix: p.prix,
          devise: p.devise,
          description: p.description,
          features: p.features,
          limiteChantiers: p.limiteChantiers,
          limiteUtilisateurs: p.limiteUtilisateurs,
        })),
      },
    };
  }
}

module.exports = SubscriptionService;