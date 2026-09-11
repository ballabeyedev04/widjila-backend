'use strict';

const { ForbiddenError } = require('../errors/AppError.js');
const { TRIAL_JOURS } = require('../config/essai.js');

/**
 * Middleware de vérification d'abonnement / trial.
 * Bloque l'accès aux routes protégées si :
 * - l'organisation n'a pas d'abonnement actif (is_subscribed = false)
 * - ET la période d'essai est expirée (trial_ends_at < now)
 *
 * Les routes exemptées : /abonnement, /webhook/stripe, /auth/*
 * À placer APRÈS checkOrganisation et checkActiveUser.
 */

// Routes qui restent accessibles même sans abonnement.
//
// `req.path` est RELATIF au routeur qui monte ce middleware. '/organisation'
// figurait ici « pour modifier l'org, voir les membres » : il ne couvrait en
// réalité AUCUNE route du routeur organisation (monté sur /api/v1/organisation,
// ses chemins relatifs sont '/', '/membres'…), mais bien celles des
// partenaires, montées sur /api/v1 sous '/organisation/partenaires' — qui
// échappaient ainsi au mur de fin d'essai. Retiré : le comportement réel des
// routes organisation ne change pas, la brèche des partenaires se referme.
const EXEMPT_PATHS = [
  '/abonnement',
  '/webhook/stripe',
  '/auth/',
];

function isExempt(path) {
  return EXEMPT_PATHS.some((p) => path.startsWith(p));
}

/**
 * Vrai si l'organisation a une souscription en vigueur, OU si elle n'a jamais
 * eu de souscription enregistrée (drapeau hérité : on ne peut rien confirmer,
 * on ne retire rien). Faux uniquement quand toutes ses souscriptions sont
 * échues ou terminées.
 */
async function _souscriptionEnVigueur(organisationId) {
  // Requires paresseux : même précaution que le chargement des modèles plus bas.
  const DroitsService = require('../modules/subscription/service/droits.service.js');
  if (await DroitsService.souscriptionActive(organisationId)) return true;

  // Seules comptent les souscriptions qui ONT ÉTÉ actives. Un paiement
  // simplement lancé (`en_attente`) ou échoué (`echec`) crée aussi une ligne :
  // le compter aurait coupé une organisation au drapeau hérité dès qu'elle
  // ouvrait la page de paiement — et durablement si elle abandonnait.
  const { Op } = require('sequelize');
  const { AbonnementSouscrit } = require('../models/index.js');
  const historique = await AbonnementSouscrit.count({
    where: { organisationId, statut: { [Op.in]: ['active', 'expiree', 'annulee'] } },
  });
  return historique === 0;
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
    //
    // NULL signifie désormais aussi « essai pas encore démarré », le cas d'une
    // inscription en attente de validation. La règle ne change pas pour
    // autant : ce compte-là ne peut pas s'authentifier (checkActiveUser), donc
    // il n'arrive jamais ici. Et fermer l'accès reste le bon défaut — c'est
    // l'ouvrir qui avait créé la faille.
    const trialEnded = !organisation.trial_ends_at || new Date(organisation.trial_ends_at) < now;
    let hasActiveSubscription = organisation.is_subscribed === true;

    // `is_subscribed` n'est remis à faux que par une résiliation explicite :
    // AUCUN traitement ne le fait quand `date_fin` est dépassée. Un seul mois
    // payé ouvrait donc l'accès indéfiniment. On confirme le drapeau par la
    // souscription elle-même (même règle que DroitsService).
    //
    // Seule une organisation qui A un historique de souscriptions, toutes
    // échues, est refusée : une organisation marquée abonnée sans aucune
    // ligne (filiale qui hérite du drapeau, données antérieures au catalogue)
    // garde son comportement — la couper serait une régression, pas un
    // correctif.
    if (hasActiveSubscription) {
      hasActiveSubscription = await _souscriptionEnVigueur(organisationId);
    }

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
      `Votre période d'essai de ${TRIAL_JOURS} jours est terminée. Veuillez souscrire un abonnement pour continuer.`,
      'SUBSCRIPTION_REQUIRED',
      { trialEnded: true, trialEndsAt: organisation.trial_ends_at }
    ));

  } catch (err) {
    next(err);
  }
};

module.exports = checkSubscription;