'use strict';

/**
 * Groupes de rôles métier pour requireRole(...).
 *
 * Définis par la responsabilité réelle de chaque acteur (cahier des charges) :
 *   - Admin            : super-admin plateforme (accès partout, géré dans le middleware)
 *   - ChefProjet       : pilote le projet, gère l'organisation et les équipes
 *   - ConducteurTravaux: encadre l'exécution sur le terrain
 *   - BureauControle   : contrôle qualité / sécurité (crée inspections, réserves, plans, docs)
 *   - MaitreOuvrage    : décide, fixe budget/délais, VALIDE chaque étape
 *   - MaitreOeuvre     : conçoit, organise, coordonne et supervise techniquement
 *   - Entreprise       : exécute les travaux (lecture + interventions sur ses réserves)
 *   - Client           : suit son projet (lecture, signatures, commentaires)
 *   - Pilote           : suivi quotidien du chantier — constate, affecte, relance,
 *                        documente, mais NE valide ni ne clôture (jamais dans PILOTAGE)
 *   - SousTraitant     : réalise la correction sur les réserves qui lui sont assignées ;
 *                        plus restreint qu'Entreprise (ne crée pas, ne gère pas les
 *                        affectations) — voir la garde dédiée dans reserve.service.js
 *
 * Le rôle 'Admin' est toujours autorisé dans requireRole — il n'a pas besoin
 * d'être listé ici (il l'est parfois par explicitation).
 */

// ── 'Entreprise' : le TITULAIRE de son organisation ────────────────────────
//
// Le compte créé par l'inscription publique porte ce rôle
// (auth.service.js#register). Il ouvre l'organisation, la paie, y invite ses
// équipes : c'est le rôle le plus élevé après le super-admin plateforme, et le
// client l'a tranché ainsi.
//
// Il figure donc dans TOUS les groupes métier ci-dessous. Chaque absence
// produisait le même symptôme : un écran ou un bouton visible, un 403 derrière,
// et un compte incapable de se servir du produit qu'il venait d'acheter — le
// paiement lui-même en a fait partie.
//
// La seule chose qui lui reste fermée, ce sont les routes de la PLATEFORME :
// elles sont gardées par `requireRole('Admin')` en clair, jamais par un de ces
// groupes. Valider les inscriptions, tarifer les formules ou lire le journal
// d'audit de toutes les organisations n'est pas son affaire.
//
// Cloisonnement inchangé : ces routes lisent l'organisation dans le JETON.
// Élargir un rôle n'ouvre jamais les données d'une autre entreprise.
const TITULAIRE = 'Entreprise';

// Gestion opérationnelle du chantier : créer/modifier structure, plans,
// documents, inspections, réserves, rapports (MOE = bras technique).
const OPERATIONNEL = ['ChefProjet', 'ConducteurTravaux', 'MaitreOeuvre', TITULAIRE];

// Opérationnel + bureau de contrôle (le BC crée aussi inspections, réserves,
// plans et documents pour ses contrôles).
const OPERATIONNEL_CONTROLE = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOeuvre', TITULAIRE];

// Pilotage / validation : le maître d'ouvrage décide et valide chaque étape.
// Utilisé pour les changements de statut, la création/validation de réserves
// et la génération de rapports. Pilote et SousTraitant en sont DÉLIBÉRÉMENT
// absents : ni l'un ni l'autre ne prononce de verdict sur une réserve.
const PILOTAGE = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre', TITULAIRE];

// Gestion de l'organisation, des membres et des équipes (MOA dirige l'org).
const GESTION = ['Admin', 'ChefProjet', 'MaitreOuvrage', TITULAIRE];

// Gestion des MEMBRES uniquement — volontairement plus large que GESTION.
//
// Une entreprise connectée au web doit pouvoir constituer son propre effectif
// (chefs de chantier, conducteurs de travaux…) comme elle le fait déjà depuis
// le mobile. Elle n'a pour autant RIEN à faire dans les réglages de
// l'organisation, les filiales, les agences ou l'import de contacts en masse :
// ces routes restent sur GESTION.
//
// Ce groupe n'est qu'un premier filtre de ROUTE. Les gardes fines vivent dans
// organisation.service.js :
//   - 'Admin' n'est jamais assignable ;
//   - nul ne modifie son propre rôle, statut ou permissions ;
//   - `_refusElevation` interdit à un appelant hors GESTION d'attribuer un
//     rôle DE gestion — sans quoi une entreprise se créerait un compte
//     ChefProjet et récupérerait tout ce qui lui est fermé ici.
const GESTION_MEMBRES = [...GESTION];

// Abonnement de SON PROPRE compte — volontairement plus large que GESTION.
//
// L'inscription publique crée l'organisation ET son premier compte, à qui elle
// donne le rôle 'Entreprise' (voir auth.service.js#register). C'est donc ce
// compte-là qui doit régler l'abonnement : il est le titulaire.
//
// Or 'Entreprise' n'appartient pas à GESTION. Les routes de facturation lui
// répondaient 403 — y compris `payment-intent`. Autrement dit, l'entreprise
// qui s'inscrit ne pouvait pas payer : à la fin de son essai, elle se
// retrouvait devant un mur d'abonnement et un bouton qui échoue, sans autre
// issue que d'écrire au support. C'est le seul cas où le refus bloque le
// paiement du produit lui-même.
//
// Aucune fuite entre organisations : toutes ces routes lisent
// `req.user.organisationId` DANS LE JETON (subscription.controller.js), jamais
// dans la requête. Un compte 'Entreprise' n'atteint donc que sa propre
// facturation.
//
// Même raisonnement que GESTION_MEMBRES juste au-dessus : l'entreprise gère ce
// qui lui appartient — son effectif, son abonnement — et rien de plus. Les
// réglages de l'organisation, les filiales et les agences restent sur GESTION.
const FACTURATION = [...GESTION];

// Dépôt d'une demande de chantier — volontairement plus large que
// OPERATIONNEL.
//
// L'entreprise envoie ses plans et demande l'ouverture du chantier : c'est le
// parcours décrit par le client. Elle n'obtient pour autant AUCUN chantier
// utilisable — tout dépôt hors super-admin naît « en_attente_validation » et
// attend le verdict de GESTION (voir chantier.service.js#creerChantier).
const DEPOSANT = [...OPERATIONNEL, 'BureauControle', 'MaitreOuvrage'];

// Verdict sur une DEMANDE de chantier — la seule porte que le titulaire ne
// franchit pas, et pour une raison précise.
//
// Règle posée par le client : « n'importe qui qui crée le chantier sauf Admin
// reste en attente ». Une demande déposée par l'entreprise et validée par
// l'entreprise ne serait plus une demande : le circuit s'annulerait de
// lui-même, et le super-admin ne verrait plus jamais passer une seule
// création.
//
// Ce n'est donc pas une fonctionnalité qu'on lui retire — c'est le contrôle
// qui donne son sens à ce qu'elle dépose.
const VALIDATION_CHANTIER = ['Admin', 'ChefProjet', 'MaitreOuvrage'];

// Actions très sensibles — supprimer un chantier, par exemple. Le rôle Admin
// passe toujours par le middleware.
//
// Le titulaire en fait partie : ce qu'il a créé, il doit pouvoir le défaire.
// L'en écarter revenait à lui demander d'appeler le support pour retirer un
// chantier ouvert par erreur.
const SENSIBLE = ['ChefProjet', TITULAIRE];

// Intervention sur les réserves : signalement, correction, validation.
// L'entreprise exécute les travaux et doit pouvoir agir sur ses réserves
// (créer, joindre des pièces, changer le statut après correction).
// 'Pilote' rejoint ce groupe (crée, affecte, met à jour le statut, comme les
// autres membres) ; 'SousTraitant' N'Y EST PAS — il n'a droit qu'aux deux
// routes explicitement ouvertes pour lui (statut, médias), voir reserve.route.js.
const RESERVE_INTERVENANTS = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre', TITULAIRE, 'Pilote'];

// Accès restreint du sous-traitant aux réserves qui lui sont assignées —
// utilisé UNIQUEMENT sur PATCH /reserves/:id/statut et POST /reserves/:id/medias
// (jamais sur la création, la modification ou les affectations). La
// restriction fine (statuts autorisés + réserve réellement assignée) est
// appliquée dans reserve.service.js#changerStatut, ce guard de route n'est
// qu'un premier filtre grossier, à l'image du reste du module.
const SOUS_TRAITANT = ['SousTraitant'];

module.exports = { TITULAIRE, VALIDATION_CHANTIER, OPERATIONNEL, OPERATIONNEL_CONTROLE, PILOTAGE, GESTION, GESTION_MEMBRES, FACTURATION, DEPOSANT, SENSIBLE, RESERVE_INTERVENANTS, SOUS_TRAITANT };
