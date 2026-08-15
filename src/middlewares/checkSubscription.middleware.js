'use strict';

const { ForbiddenError } = require('../errors/AppError.js');

/**
 * Middleware de vérification d'abonnement / trial.
 * Bloque l'accès aux routes protégées si :
 * - l'organisation n'a pas d'abonnement actif (is_subscribed = false)
 * - ET la période d'essai est expirée (trial_ends_at < now)
 *
 * Les routes exemptées : /abonnement, /webhook/stripe, /auth/*
 * À placer APRÈS checkOrganisation et checkActiveUser.
 */

// Routes qui restent accessibles même sans abonnement
const EXEMPT_PATHS = [
  '/abonnement',
  '/webhook/stripe',
  '/auth/',
  '/organisation', // pour modifier l'org, voir les membres
];

function isExempt(path) {
  return EXEMPT_PATHS.some((p) => path.startsWith(p));
}

const checkSubscription = async (req, res, next) => {
  try {
    // Requête non authentifiée : rien à vérifier ici. Ce middleware est aussi
    // monté en filet global sur /api/v1 (app.js), où il voit passer les routes
    // inconnues — sans cette garde, `req.user.role` levait une TypeError et
    // toute URL inexistante répondait 500 au lieu de 404.
    // Les routes réelles restent protégées par `auth` en amont.
    if (!req.user) {
      return next();
    }

    // Admin plateforme : pas de restriction
    if (req.user.role === 'Admin') {
      return next();
    }

    // Routes exemptées (page abonnement, webhook, auth)
    if (isExempt(req.path)) {
      return next();
    }

    const organisationId = req.user.organisationId;
    if (!organisationId) {
      // Super-admin sans organisation (ne devrait pas arriver hors Admin)
      return next();
    }

    const { Organisation } = require('../models/index.js');
    const organisation = await Organisation.findByPk(organisationId, {
      attributes: ['id', 'is_subscribed', 'trial_ends_at'],
    });

    if (!organisation) {
      return next(new ForbiddenError('Organisation introuvable'));
    }

    const now = new Date();
    // Un `trial_ends_at` NULL comptait comme « essai en cours », donc accès
    // gratuit ILLIMITÉ. Les organisations créées hors du parcours d'inscription
    // (filiales, agences, création par l'admin plateforme) n'avaient jamais de
    // date d'essai. Absence de date ⇒ essai terminé.
    const trialEnded = !organisation.trial_ends_at || new Date(organisation.trial_ends_at) < now;
    const hasActiveSubscription = organisation.is_subscribed === true;

    // Accès autorisé si abonnement actif OU trial en cours
    if (hasActiveSubscription || !trialEnded) {
      // Attacher l'info d'abonnement pour les contrôleurs qui en ont besoin
      req.subscription = {
        isSubscribed: hasActiveSubscription,
        trialEnded,
        trialEndsAt: organisation.trial_ends_at,
      };
      return next();
    }

    // Trial expiré et pas d'abonnement → bloquer
    return next(new ForbiddenError(
      'Votre période d\'essai de 7 jours est terminée. Veuillez souscrire un abonnement pour continuer.',
      'SUBSCRIPTION_REQUIRED',
      { trialEnded: true, trialEndsAt: organisation.trial_ends_at }
    ));

  } catch (err) {
    next(err);
  }
};

module.exports = checkSubscription;