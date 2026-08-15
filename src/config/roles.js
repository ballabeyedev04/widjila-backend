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
// et la génération de rapports.
const PILOTAGE = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre'];

// Gestion de l'organisation, des membres et des équipes (MOA dirige l'org).
const GESTION = ['Admin', 'ChefProjet', 'MaitreOuvrage'];

// Actions très sensibles réservées au chef de projet (le rôle Admin passe
// toujours par le middleware). Ex : supprimer un chantier.
const SENSIBLE = ['ChefProjet'];

// Intervention sur les réserves : signalement, correction, validation.
// L'entreprise exécute les travaux et doit pouvoir agir sur ses réserves
// (créer, joindre des pièces, changer le statut après correction).
const RESERVE_INTERVENANTS = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage', 'MaitreOeuvre', 'Entreprise'];

module.exports = { OPERATIONNEL, OPERATIONNEL_CONTROLE, PILOTAGE, GESTION, SENSIBLE, RESERVE_INTERVENANTS };
