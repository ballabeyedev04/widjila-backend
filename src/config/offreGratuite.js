'use strict';

/**
 * L'OFFRE GRATUITE — ce qu'une organisation peut faire sans rien payer, pour
 * toujours.
 *
 * ── Pourquoi elle existe ──────────────────────────────────────────────────
 *
 * Jusqu'ici, une organisation dont l'essai de deux jours s'achevait perdait
 * TOUT accès : plus un chantier, plus une réserve, un mur. Deux conséquences.
 *
 * Pour le client : deux jours ne suffisent pas à juger d'un outil de chantier,
 * où le rythme est celui des semaines. Beaucoup se heurtaient au mur avant
 * d'avoir relevé leur première série de réserves.
 *
 * Pour la distribution : l'App Store a refusé l'application (directive 3.1.1,
 * 23/09/2026) parce qu'un contenu payant y était accessible sans achat
 * intégré, et que l'inscription d'entreprise y menait. Une application dont
 * l'usage est RÉELLEMENT gratuit, et qui ne vend rien en son sein, ne pose
 * plus cette question : l'inscription ne mène plus à un achat, elle mène à un
 * produit utilisable.
 *
 * ── Ce qu'elle donne ──────────────────────────────────────────────────────
 *
 * Un chantier, deux utilisateurs, et TOUT le reste sans restriction :
 * réserves illimitées, photos, plans annotés, rapports. Ce sont les VOLUMES
 * qui distinguent les formules payantes, pas les fonctionnalités — une
 * entreprise qui ne gère qu'un chantier à la fois n'a aucune raison d'être
 * privée des plans annotés, et une qui en gère quinze paiera pour les quinze.
 *
 * `fonctionnalites: null` signifie « toutes » (voir `DroitsService.peutUtiliser`,
 * où un tableau vide signifierait au contraire « aucune »).
 *
 * ── Son rang ──────────────────────────────────────────────────────────────
 *
 * Elle n'est jamais qu'un SOCLE : une souscription payante active la
 * remplace, et l'essai en cours — sans limite de volume — la couvre tant
 * qu'il dure. Elle ne s'applique donc qu'une fois l'essai terminé et aucune
 * formule souscrite. Voir `DroitsService.getDroits`.
 */

/** Code porté par `droits.planCode` — distinct de tout code du catalogue. */
const CODE_GRATUIT = '__gratuit__';

/** Ce que voit l'utilisateur. Traduit côté client, jamais recomposé ici. */
const NOM_GRATUIT = 'Offre gratuite';

/** Un seul chantier à la fois : c'est le plafond qui invite à passer payant. */
const LIMITE_CHANTIERS = 1;

/** Deux comptes : le relevé à deux (bureau + terrain) reste possible. */
const LIMITE_UTILISATEURS = 2;

module.exports = {
  CODE_GRATUIT,
  NOM_GRATUIT,
  LIMITE_CHANTIERS,
  LIMITE_UTILISATEURS,
};
