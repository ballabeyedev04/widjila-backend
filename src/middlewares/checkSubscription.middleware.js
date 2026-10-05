'use strict';

/**
 * Contexte d'abonnement de la requête.
 *
 * ── Ce middleware ne REFUSE plus rien ─────────────────────────────────────
 *
 * Il a longtemps été le mur de fin d'essai : passé deux jours sans
 * souscription, toute route protégée répondait « Votre période d'essai est
 * terminée. Veuillez souscrire un abonnement pour continuer. » Plus un
 * chantier, plus une réserve, plus un plan.
 *
 * Ce mur n'a plus lieu d'être : l'OFFRE GRATUITE (src/config/offreGratuite.js)
 * est permanente. Une organisation sans souscription garde un chantier, deux
 * utilisateurs et des réserves illimitées — pour toujours. Il n'existe donc
 * plus aucun état où l'on doive fermer la porte faute d'avoir payé.
 *
 * Ce que coûtait l'oubli : l'offre gratuite avait été posée dans
 * `DroitsService` — qui dit ce à quoi on a droit — sans que ce garde-barrière
 * en soit informé. L'application annonçait une offre gratuite et répondait
 * 403 sur chaque écran. C'est ce qu'ont vu les premiers utilisateurs iOS.
 *
 * ── Où les limites s'appliquent, alors ────────────────────────────────────
 *
 * Là où elles ont un sens : au moment de CRÉER. `verifierLimite('chantiers')`
 * et `verifierLimite('utilisateurs')` (requireFonctionnalite.middleware.js)
 * refusent le deuxième chantier ou le troisième compte, en annonçant le
 * plafond. Lire, modifier et travailler sur l'existant reste ouvert.
 *
 * Conséquence assumée : une organisation qui avait dix chantiers sous une
 * formule payante échue les garde accessibles, et ne peut simplement plus en
 * créer. C'est voulu — on ne prend pas en otage le travail déjà fait.
 *
 * ── Ce qu'il fait encore ──────────────────────────────────────────────────
 *
 * Il attache `req.subscription` pour les contrôleurs qui veulent adapter leur
 * réponse. La source de vérité des droits reste `DroitsService.getDroits`.
 *
 * Il reste monté sur les routes : le jour où un état devrait de nouveau
 * fermer l'accès, c'est ici, et seulement ici, que cela s'écrirait.
 */

// Routes pour lesquelles ce contexte n'apporte rien : on s'épargne la
// lecture de l'organisation.
//
// Elles étaient autrefois « exemptées du mur de fin d'essai » — il fallait
// bien pouvoir atteindre la page d'abonnement pour en sortir. Le mur n'existe
// plus ; la liste ne fait désormais qu'éviter une requête inutile.
const EXEMPT_PATHS = [
  '/abonnement',
  '/webhook/stripe',
  '/auth/',
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

    // Un `trial_ends_at` NULL vaut « essai terminé ». Deux situations le
    // produisent : une organisation créée hors du parcours d'inscription
    // (filiale, agence, création par l'administration), et une inscription
    // pas encore validée. Dans les deux cas, l'offre gratuite prend le
    // relais — c'est une information, plus une sanction.
    const trialEnded = !organisation.trial_ends_at
      || new Date(organisation.trial_ends_at) < new Date();

    req.subscription = {
      // Le drapeau STOCKÉ, pas un droit : il n'est remis à faux que par une
      // résiliation explicite. Qui veut savoir ce que l'organisation peut
      // réellement faire interroge `DroitsService.getDroits`, qui tranche
      // entre souscription active, essai en cours et offre gratuite.
      isSubscribed: organisation.is_subscribed === true,
      trialEnded,
      trialEndsAt: organisation.trial_ends_at,
    };

    return next();

  } catch (err) {
    next(err);
  }
};

module.exports = checkSubscription;