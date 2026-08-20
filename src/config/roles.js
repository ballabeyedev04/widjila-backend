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

// Gestion opérationnelle du chantier : créer/modifier structure, plans,
// documents, inspections, réserves, rapports (MOE = bras technique).
const OPERATIONNEL = ['ChefProjet', 'ConducteurTravaux', 'MaitreOeuvre'];

// Opérationnel + bureau de contrôle (le BC crée aussi inspections, réserves,
// plans et documents pour ses contrôles).
const OPERATIONNEL_CONTROLE = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOeuvre'];

// Pilotage / validation : le maître d'ouvrage décide et valide chaque étape.
// Utilisé pour les changements de statut, la création/validation de réserves
// et la génération de rapports. Pilote et SousTraitant en sont DÉLIBÉRÉMENT
// absents : ni l'un ni l'autre ne prononce de verdict sur une réserve.
const PILOTAGE = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre'];

// Gestion de l'organisation, des membres et des équipes (MOA dirige l'org).
const GESTION = ['Admin', 'ChefProjet', 'MaitreOuvrage'];

// Actions très sensibles réservées au chef de projet (le rôle Admin passe
// toujours par le middleware). Ex : supprimer un chantier.
const SENSIBLE = ['ChefProjet'];

// Intervention sur les réserves : signalement, correction, validation.
// L'entreprise exécute les travaux et doit pouvoir agir sur ses réserves
// (créer, joindre des pièces, changer le statut après correction).
// 'Pilote' rejoint ce groupe (crée, affecte, met à jour le statut, comme les
// autres membres) ; 'SousTraitant' N'Y EST PAS — il n'a droit qu'aux deux
// routes explicitement ouvertes pour lui (statut, médias), voir reserve.route.js.
const RESERVE_INTERVENANTS = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre', 'Entreprise', 'Pilote'];

// Accès restreint du sous-traitant aux réserves qui lui sont assignées —
// utilisé UNIQUEMENT sur PATCH /reserves/:id/statut et POST /reserves/:id/medias
// (jamais sur la création, la modification ou les affectations). La
// restriction fine (statuts autorisés + réserve réellement assignée) est
// appliquée dans reserve.service.js#changerStatut, ce guard de route n'est
// qu'un premier filtre grossier, à l'image du reste du module.
const SOUS_TRAITANT = ['SousTraitant'];

module.exports = { OPERATIONNEL, OPERATIONNEL_CONTROLE, PILOTAGE, GESTION, SENSIBLE, RESERVE_INTERVENANTS, SOUS_TRAITANT };
