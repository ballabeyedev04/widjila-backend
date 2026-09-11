'use strict';

const models = require('../models/index.js');
const { NotFoundError } = require('../errors/AppError.js');
const { GESTION } = require('../config/roles.js');

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
  hotspotId:    { modele: 'PlanHotspot', colonne: 'planId',   vers: 'planId',     libelle: 'Repère' },
  reserveId:    { modele: 'Reserve',    colonne: 'chantierId', vers: 'chantierId', libelle: 'Réserve' },
  documentId:   { modele: 'Document',   colonne: 'chantierId', vers: 'chantierId', libelle: 'Document' },
  inspectionId: { modele: 'Inspection', colonne: 'chantierId', vers: 'chantierId', libelle: 'Inspection' },
  rapportId:    { modele: 'Rapport',    colonne: 'chantierId', vers: 'chantierId', libelle: 'Rapport' },
  pieceJointeId: { modele: 'PieceJointe', colonne: 'reserveId', vers: 'reserveId', libelle: 'Pièce jointe' },
  // Média de RÉSERVE. Un média d'inspection (reserveId nul) s'arrête là : son
  // cadrage reste celui du service, par organisation.
  mediaId:      { modele: 'Media',      colonne: 'reserveId',  vers: 'reserveId',  libelle: 'Média' },
};

const estSuperAdmin = (user) => user?.role === 'Admin';

/** Chantier dont dépend une ressource — même table de remontée, arrêtée au chantier. */
async function _chantierDe(type, id) {
  if (type === 'chantierId') return id;
  const etape = CHAINE[type];
  if (!etape) return null;
  const ligne = await models[etape.modele].findByPk(id, { attributes: [etape.colonne], paranoid: false });
  const valeur = ligne ? ligne[etape.colonne] : null;
  return valeur ? _chantierDe(etape.vers, valeur) : null;
}

/**
 * Cloisonnement des chantiers AU SEIN d'une organisation.
 *
 * Un chantier issu du circuit de demande (`demandeurId` renseigné) n'est
 * visible que de son demandeur, des rôles de GESTION et de ses membres —
 * règle posée par `ChantierService._filtreCloisonnement` (liste) et
 * `_peutVoir` (détail). Elle n'était appliquée QUE là : les réserves,
 * documents, inspections, plans, médias, rapports et le tableau de bord d'un
 * chantier caché restaient lisibles et modifiables par tout membre de
 * l'organisation qui en connaissait l'identifiant (il fuit par les listes
 * transversales).
 *
 * Tous ces contrôleurs passent par `organisationCible` : la règle est posée
 * ici, une fois. S'y ajoute, par rapport à la liste, l'AFFECTATION à une
 * réserve du chantier — un sous-traitant assigné doit pouvoir atteindre la
 * réserve qu'on lui confie sans être membre du chantier.
 *
 * « Introuvable » plutôt qu'« interdit » : même réponse que le détail, qui ne
 * confirme pas l'existence du chantier d'un tiers.
 */
async function _verifierCloisonnement(user, cible) {
  if (!user || !user.id || estSuperAdmin(user) || GESTION.includes(user.role)) return;

  const entree = Object.entries(cible).find(([type, id]) => id && (type === 'chantierId' || CHAINE[type]));
  if (!entree) return;

  const chantierId = await _chantierDe(entree[0], entree[1]);
  if (!chantierId) return;

  const chantier = await models.Chantier.findByPk(chantierId, {
    attributes: ['id', 'organisationId', 'demandeurId'],
    paranoid: false,
  });
  // Chantier absent ou d'une autre organisation : le service répondra
  // « introuvable » avec son propre filtre, rien à ajouter ici.
  if (!chantier || String(chantier.organisationId) !== String(user.organisationId)) return;
  if (!chantier.demandeurId || String(chantier.demandeurId) === String(user.id)) return;

  const membre = await models.ChantierMembre.count({ where: { chantierId, utilisateurId: user.id } });
  if (membre > 0) return;

  const assigne = await models.Reserve.count({ where: { chantierId, assigneA: user.id } })
    || await models.ReserveAffectation.count({
      where: { utilisateurId: user.id },
      include: [{ model: models.Reserve, as: 'reserve', where: { chantierId }, attributes: [] }],
    });
  if (assigne > 0) return;

  throw new NotFoundError('Chantier introuvable');
}

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
  if (!estSuperAdmin(req.user)) {
    await _verifierCloisonnement(req.user, cible);
    return req.user.organisationId;
  }

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
  // Exposé pour les services qui reçoivent un chantier hors de `organisationCible`.
  verifierCloisonnement: _verifierCloisonnement,
};
