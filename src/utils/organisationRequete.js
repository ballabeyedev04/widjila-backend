'use strict';

const models = require('../models/index.js');
const { NotFoundError } = require('../errors/AppError.js');

/**
 * Organisation dans laquelle une requête opère.
 *
 * Tous les services filtrent sur `organisationId` (isolation multi-tenant).
 * Pour un utilisateur normal, c'est celle de son compte. Le super-admin
 * plateforme (`role: 'Admin'`) n'appartient à AUCUNE organisation : lui passer
 * son `organisationId` — c'est-à-dire `null` — faisait échouer chaque
 * opération sur une ressource cliente (« chantier introuvable », « plan
 * introuvable », violation de contrainte NOT NULL en création). Il travaille
 * donc dans l'organisation DE LA RESSOURCE visée.
 *
 * Seul le chantier porte un `organisationId`. Tout le reste en dépend :
 *
 *   annotation → plan → chantier → organisation
 *   média      → réserve/inspection → chantier → organisation
 *   réserve | document | inspection | rapport  → chantier → organisation
 *
 * D'où la table de remontée ci-dessous plutôt qu'une fonction par modèle :
 * ajouter un type de ressource, c'est ajouter une ligne.
 *
 * `paranoid: false` : on ne lit ici que de quoi cadrer l'appel. Une ressource
 * soft-deleted appartient toujours à son propriétaire, et sa suppression
 * définitive doit rester possible.
 */

// clé = nom du paramètre accepté par `organisationCible`
const CHAINE = {
  chantierId:   { modele: 'Chantier',   colonne: 'organisationId', libelle: 'Chantier' },
  planId:       { modele: 'Plan',       colonne: 'chantierId', vers: 'chantierId', libelle: 'Plan' },
  annotationId: { modele: 'Annotation', colonne: 'planId',     vers: 'planId',     libelle: 'Annotation' },
  reserveId:    { modele: 'Reserve',    colonne: 'chantierId', vers: 'chantierId', libelle: 'Réserve' },
  documentId:   { modele: 'Document',   colonne: 'chantierId', vers: 'chantierId', libelle: 'Document' },
  inspectionId: { modele: 'Inspection', colonne: 'chantierId', vers: 'chantierId', libelle: 'Inspection' },
  rapportId:    { modele: 'Rapport',    colonne: 'chantierId', vers: 'chantierId', libelle: 'Rapport' },
  pieceJointeId: { modele: 'PieceJointe', colonne: 'reserveId', vers: 'reserveId', libelle: 'Pièce jointe' },
};

const estSuperAdmin = (user) => user?.role === 'Admin';

/** Remonte la chaîne jusqu'à l'`organisationId` du chantier propriétaire. */
async function _remonter(type, id) {
  const etape = CHAINE[type];
  if (!etape) throw new Error(`organisationCible : type de ressource inconnu « ${type} »`);

  const ligne = await models[etape.modele].findByPk(id, {
    attributes: [etape.colonne],
    paranoid: false,
  });
  if (!ligne) throw new NotFoundError(`${etape.libelle} introuvable`);

  const valeur = ligne[etape.colonne];
  if (!etape.vers) return valeur;          // chantier : on tient l'organisation
  if (!valeur) return null;                // maillon orphelin (média sans réserve…)
  return _remonter(etape.vers, valeur);
}

/**
 * @param {object} req
 * @param {object} cible  Un seul identifiant, ex. { chantierId } | { reserveId }
 * @returns {Promise<string|null>} organisationId à passer au service
 */
async function organisationCible(req, cible = {}) {
  if (!estSuperAdmin(req.user)) return req.user.organisationId;

  // Déjà chargée par checkOrganisation sur les routes qui l'utilisent :
  // on évite une seconde lecture.
  if (req.resource?.organisationId) return req.resource.organisationId;

  for (const [type, id] of Object.entries(cible)) {
    if (id) return _remonter(type, id);
  }

  return req.user.organisationId;
}

/** Organisation d'un chantier, hors contexte de requête. */
const organisationDuChantier = (chantierId) => _remonter('chantierId', chantierId);

module.exports = {
  estSuperAdmin,
  organisationCible,
  organisationDuChantier,
};
