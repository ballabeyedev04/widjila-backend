'use strict';

/**
 * Essai gratuit — sa durée, et l'instant où le compte à rebours démarre.
 *
 * ## Pourquoi l'horloge ne part PAS à l'inscription
 *
 * Une inscription publique ne crée pas un compte utilisable : elle dépose une
 * DEMANDE. Le compte naît « en_attente_validation » et la connexion lui est
 * refusée tant que le super-admin n'a pas tranché (auth.service.js#register,
 * checkActiveUser.middleware.js).
 *
 * Un essai démarré à l'inscription s'écoulait donc pendant que l'entreprise
 * attendait, sans pouvoir se connecter une seule fois. Validée au-delà du
 * délai, elle arrivait sur « votre période d'essai est terminée » à sa toute
 * première connexion — un message incompréhensible pour qui n'a jamais eu
 * l'occasion d'essayer quoi que ce soit.
 *
 * L'horloge part donc à la VALIDATION, seul instant où l'usage devient
 * réellement possible (essai.service.js#demarrerEssai).
 *
 * ## Ce que vaut `trial_ends_at` à NULL
 *
 * NULL signifie « essai NON DÉMARRÉ », et reste traité comme un essai TERMINÉ
 * par les gardes (checkSubscription, droits.service). Ce choix est délibéré :
 *   - une organisation en attente de validation ne peut de toute façon pas
 *     s'authentifier, donc aucune garde ne l'évalue jamais ;
 *   - une organisation créée hors du parcours d'inscription (filiale, agence,
 *     création par la plateforme) reçoit le défaut ci-dessous, jamais NULL ;
 *   - et si un NULL survivait malgré tout, il ferme l'accès au lieu de
 *     l'ouvrir indéfiniment — c'était précisément la faille corrigée par la
 *     migration 20260814000002.
 */

/** Durée de l'essai, en jours. Valeur unique — ne pas la recopier ailleurs. */
const TRIAL_JOURS = 2;

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

/**
 * Fin de l'essai pour un démarrage à `depuis`.
 * @param {Date} [depuis] Instant de démarrage (par défaut : maintenant).
 * @returns {Date}
 */
function finEssai(depuis = new Date()) {
  return new Date(depuis.getTime() + TRIAL_JOURS * MS_PAR_JOUR);
}

module.exports = { TRIAL_JOURS, finEssai };
