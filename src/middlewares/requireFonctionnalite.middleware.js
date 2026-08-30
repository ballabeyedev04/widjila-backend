'use strict';

const DroitsService = require('../modules/subscription/service/droits.service.js');
const { ForbiddenError } = require('../errors/AppError.js');
const { libelle } = require('../config/fonctionnalites.js');

/**
 * Gardes d'abonnement — la SEULE application qui fasse foi.
 *
 * Le web et le mobile peuvent masquer un bouton pour le confort, mais un appel
 * direct à l'API — code mobile modifié, requête forgée — se heurte à ces
 * middlewares. Ils ne dupliquent aucune règle : tout vient de
 * `DroitsService`.
 *
 * ── Codes renvoyés ────────────────────────────────────────────────────────
 *   SUBSCRIPTION_REQUIRED              aucun abonnement actif ni essai
 *   SUBSCRIPTION_FEATURE_UNAVAILABLE   la formule n'ouvre pas cette option
 *   SUBSCRIPTION_LIMIT_REACHED         plafond de la formule atteint
 *
 * Ils sont STABLES et non traduits : le client s'y branche pour proposer
 * « Voir les abonnements », là où un message libre changerait au premier
 * ajustement de formulation.
 */

/**
 * Exige une fonctionnalité de la formule.
 *
 * @param {string} fonctionnalite — code du catalogue (config/fonctionnalites.js)
 */
function requireFonctionnalite(fonctionnalite) {
  return async function verifier(req, res, next) {
    try {
      // Le super-admin plateforme n'appartient à aucune organisation : il
      // n'est donc soumis à aucune formule. Le filtrer ici lui fermerait
      // l'administration qu'il est censé exercer.
      if (req.user?.role === 'Admin') return next();

      const organisationId = req.user?.organisationId;
      const { autorise, raison, droits } = await DroitsService.peutUtiliser(
        organisationId, fonctionnalite
      );
      if (autorise) {
        req.droitsAbonnement = droits;
        return next();
      }

      const message = raison === 'SUBSCRIPTION_REQUIRED'
        ? 'Aucun abonnement actif. Souscrivez une formule pour utiliser cette fonctionnalité.'
        : `« ${libelle(fonctionnalite)} » n’est pas incluse dans votre abonnement ${droits.planNom || ''}.`.trim();

      return next(new ForbiddenError(message, raison));
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Exige qu'une limite de volume ne soit pas atteinte.
 *
 * Posé AVANT le contrôleur : refuser après la création laisserait la ressource
 * en base et le plafond dépassé.
 *
 * @param {'utilisateurs'|'chantiers'} ressource
 * @param {number|Function} [aAjouter=1] Nombre d'éléments créés par l'appel,
 *   ou une fonction `(req) => nombre` quand il dépend du corps de la requête
 *   (import en masse).
 */
function verifierLimite(ressource, aAjouter = 1) {
  return async function verifier(req, res, next) {
    try {
      if (req.user?.role === 'Admin') return next();

      const organisationId = req.user?.organisationId;
      const nombre = typeof aAjouter === 'function' ? (aAjouter(req) || 1) : aAjouter;

      const resultat = await DroitsService.verifierLimite(organisationId, ressource, nombre);
      if (resultat.autorise) {
        req.droitsAbonnement = resultat.droits;
        return next();
      }

      if (resultat.raison === 'SUBSCRIPTION_REQUIRED') {
        return next(new ForbiddenError(
          'Aucun abonnement actif. Souscrivez une formule pour continuer.',
          'SUBSCRIPTION_REQUIRED'
        ));
      }

      const nom = ressource === 'utilisateurs' ? 'utilisateurs' : 'chantiers';
      return next(new ForbiddenError(
        `Votre abonnement ${resultat.droits.planNom || ''} est limité à ${resultat.limite} ${nom} `
        + `(${resultat.courant} utilisé${resultat.courant > 1 ? 's' : ''}). `
        + 'Passez à une formule supérieure pour en ajouter.',
        'SUBSCRIPTION_LIMIT_REACHED'
      ));
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireFonctionnalite, verifierLimite };
