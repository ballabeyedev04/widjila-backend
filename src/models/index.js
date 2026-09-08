const Utilisateur         = require('./utilisateur.model.js');
const Organisation        = require('./organisation.model.js');
const Equipe              = require('./equipe.model.js');
const RefreshToken        = require('./refreshToken.model.js');
const UserOtp             = require('./userOtp.model.js');
const DeviceToken         = require('./deviceToken.model.js');
const AuditLog            = require('./auditLog.model.js');
const Chantier            = require('./chantier.model.js');
const Batiment            = require('./batiment.model.js');
const Etage               = require('./etage.model.js');
const Zone                = require('./zone.model.js');
const Lot                 = require('./lot.model.js');
const Plan                = require('./plan.model.js');
const Reserve             = require('./reserve.model.js');
const ReservePosition     = require('./reservePosition.model.js');
const Media               = require('./media.model.js');
const Commentaire         = require('./commentaire.model.js');
const ReserveHistorique   = require('./reserveHistorique.model.js');
const Inspection          = require('./inspection.model.js');
const Checklist           = require('./checklist.model.js');
const Document            = require('./document.model.js');
const Notification        = require('./notification.model.js');
const Rapport             = require('./rapport.model.js');
// ── Extensions modules 1-9 ─────────────────────────────────────────────
const ConnexionLog       = require('./connexionLog.model.js');
const ChantierMembre     = require('./chantierMembre.model.js');
const Phase              = require('./phase.model.js');
const Annotation         = require('./annotation.model.js');
const PlanHotspot        = require('./planHotspot.model.js');
const CorpsEtat          = require('./corpsEtat.model.js');
const TypeDocument       = require('./typeDocument.model.js');
const CodeNiveau         = require('./codeNiveau.model.js');
const TypePartenaire     = require('./typePartenaire.model.js');
const TypeInspection     = require('./typeInspection.model.js');
const PlanAbonnement     = require('./planAbonnement.model.js');
const AbonnementSouscrit = require('./abonnementSouscrit.model.js');
const EvenementPaiement  = require('./evenementPaiement.model.js');
const PieceJointe        = require('./pieceJointe.model.js');
const Signature          = require('./signature.model.js');
const ReserveAffectation = require('./reserveAffectation.model.js');
const ChecklistModele    = require('./checklistModele.model.js');
const Convocation        = require('./convocation.model.js');
const Partenaire         = require('./partenaire.model.js');
const MfaChallenge       = require('./mfaChallenge.model.js');
const DemandeSuppression = require('./demandeSuppression.model.js');

// ══════════════════════════════════════════════════════════════════════════
//  ASSOCIATIONS
//  Chaque modèle est enregistré ici avec ses liens. Les associations suivent
//  le schéma du cahier des charges (Organisation → Chantier → Bâtiments →
//  Étages → Zones → Plans → Réserves → Médias/Commentaires/Historique).
// ══════════════════════════════════════════════════════════════════════════

// ── Organisation ↔ Utilisateurs / Équipes / Chantiers ─────────────────────
Organisation.hasMany(Utilisateur, { foreignKey: 'organisationId', as: 'membres', onDelete: 'CASCADE' });
Utilisateur.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

Organisation.hasMany(Equipe, { foreignKey: 'organisationId', as: 'equipes', onDelete: 'CASCADE' });
Equipe.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

// Équipes ↔ Utilisateurs (many-to-many)
Equipe.belongsToMany(Utilisateur, { through: 'equipe_membres', foreignKey: 'equipeId', as: 'membres' });
Utilisateur.belongsToMany(Equipe, { through: 'equipe_membres', foreignKey: 'utilisateurId', as: 'equipes' });

// ── Hiérarchie organisationnelle (filiales / agences) — module 2 ──────────
Organisation.belongsTo(Organisation, { foreignKey: 'parent_id', as: 'parent' });
Organisation.hasMany(Organisation, { foreignKey: 'parent_id', as: 'filiales' });

// ── Chantiers ──────────────────────────────────────────────────────────────
Organisation.hasMany(Chantier, { foreignKey: 'organisationId', as: 'chantiers', onDelete: 'CASCADE' });
Chantier.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

// Responsable du chantier (utilisateur)
Utilisateur.hasMany(Chantier, { foreignKey: 'responsableId', as: 'chantiers_responsable' });
Chantier.belongsTo(Utilisateur, { foreignKey: 'responsableId', as: 'responsable' });
// Circuit de validation : le demandeur reçoit les courriels de verdict, le
// valideur figure dans l'historique. Deux associations distinctes vers le même
// modèle, d'où les alias explicites.
Chantier.belongsTo(Utilisateur, { foreignKey: 'demandeurId', as: 'demandeur' });
Chantier.belongsTo(Utilisateur, { foreignKey: 'valideParId', as: 'validePar' });

// Affectation des utilisateurs à plusieurs chantiers — module 1
Utilisateur.belongsToMany(Chantier, { through: ChantierMembre, foreignKey: 'utilisateurId', as: 'chantiers' });
Chantier.belongsToMany(Utilisateur, { through: ChantierMembre, foreignKey: 'chantierId', as: 'membres' });

// Phases / planning — module 3
Chantier.hasMany(Phase, { foreignKey: 'chantierId', as: 'phases', onDelete: 'CASCADE' });
Phase.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

// ── Décomposition d'un chantier ────────────────────────────────────────────
Chantier.hasMany(Batiment, { foreignKey: 'chantierId', as: 'batiments', onDelete: 'CASCADE' });
Batiment.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

Batiment.hasMany(Etage, { foreignKey: 'batimentId', as: 'etages', onDelete: 'CASCADE' });
Etage.belongsTo(Batiment, { foreignKey: 'batimentId', as: 'batiment' });

Etage.hasMany(Zone, { foreignKey: 'etageId', as: 'zones', onDelete: 'CASCADE' });
Zone.belongsTo(Etage, { foreignKey: 'etageId', as: 'etage' });

Chantier.hasMany(Lot, { foreignKey: 'chantierId', as: 'lots', onDelete: 'CASCADE' });
Lot.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

// ── Plans & annotations ────────────────────────────────────────────────────
Chantier.hasMany(Plan, { foreignKey: 'chantierId', as: 'plans', onDelete: 'CASCADE' });
Plan.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

// ── Plans de DÉTAIL — un plan dans un plan ──────────────────────────────────
//
// Relation récursive : elle donne une profondeur quelconque sous le dernier
// niveau de structure (le plan d'une pièce dans un appartement) sans ajouter
// une table par niveau.
//
// `SET NULL` et non `CASCADE` : le modèle est `paranoid`, donc ce comportement
// ne joue qu'en cas de suppression PHYSIQUE. Un plan de détail qui perd son
// parent redevient alors un plan ordinaire rattaché à son niveau de structure,
// au lieu de disparaître avec toutes les réserves relevées dessus.
Plan.hasMany(Plan, { foreignKey: 'parentId', as: 'sousPlans', onDelete: 'SET NULL' });
Plan.belongsTo(Plan, { foreignKey: 'parentId', as: 'parent' });

Zone.hasMany(Plan, { foreignKey: 'zoneId', as: 'plans' });
Plan.belongsTo(Zone, { foreignKey: 'zoneId', as: 'zone' });

// Un plan décrit le niveau auquel il est rattaché : le chantier entier (aucun
// rattachement), un bâtiment, un étage, ou une zone. Voir plan.model.js.
Batiment.hasMany(Plan, { foreignKey: 'batimentId', as: 'plans' });
Plan.belongsTo(Batiment, { foreignKey: 'batimentId', as: 'batiment' });

Etage.hasMany(Plan, { foreignKey: 'etageId', as: 'plans' });
Plan.belongsTo(Etage, { foreignKey: 'etageId', as: 'etage' });

// Zones cliquables d'un plan — navigation « plan global → bâtiment → étage →
// appartement » du guide client. Voir planHotspot.model.js.
Plan.hasMany(PlanHotspot, { foreignKey: 'planId', as: 'hotspots', onDelete: 'CASCADE' });
PlanHotspot.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });

// Annotations sur les plans — module 4
Plan.hasMany(Annotation, { foreignKey: 'planId', as: 'annotations', onDelete: 'CASCADE' });
Annotation.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
Annotation.belongsTo(Utilisateur, { foreignKey: 'creePar', as: 'createur' });

// ── Réserves ───────────────────────────────────────────────────────────────
Chantier.hasMany(Reserve, { foreignKey: 'chantierId', as: 'reserves', onDelete: 'CASCADE' });
Reserve.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

Batiment.hasMany(Reserve, { foreignKey: 'batimentId', as: 'reserves' });
Reserve.belongsTo(Batiment, { foreignKey: 'batimentId', as: 'batiment' });

Etage.hasMany(Reserve, { foreignKey: 'etageId', as: 'reserves' });
Reserve.belongsTo(Etage, { foreignKey: 'etageId', as: 'etage' });

Zone.hasMany(Reserve, { foreignKey: 'zoneId', as: 'reserves' });
Reserve.belongsTo(Zone, { foreignKey: 'zoneId', as: 'zone' });

Plan.hasMany(Reserve, { foreignKey: 'planId', as: 'reserves' });
Reserve.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });

// ── Abonnements ────────────────────────────────────────────────────────────
// `PlanAbonnement` est le CATALOGUE (Essentiel, Pro, Entreprise) ; à ne pas
// confondre avec `Plan`, qui désigne les plans de chantier.
//
// `AbonnementSouscrit` garde l'historique : la formule y est recopiée (code,
// nom, prix payé), d'où le `SET NULL` — supprimer une formule du catalogue ne
// doit pas effacer la trace de ceux qui l'ont payée.
PlanAbonnement.hasMany(AbonnementSouscrit, { foreignKey: 'planAbonnementId', as: 'souscriptions' });
AbonnementSouscrit.belongsTo(PlanAbonnement, { foreignKey: 'planAbonnementId', as: 'plan' });

Organisation.hasMany(AbonnementSouscrit, { foreignKey: 'organisationId', as: 'souscriptions', onDelete: 'CASCADE' });
AbonnementSouscrit.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

// Catalogue des corps d'état (métiers BTP) — voir corpsEtat.model.js.
// `organisationId` nul = catalogue standard partagé par toute la plateforme.
Organisation.hasMany(CorpsEtat, { foreignKey: 'organisationId', as: 'corpsEtat', onDelete: 'CASCADE' });
CorpsEtat.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

// Référentiels de TYPE administrables (documents, intervenants, inspections).
//
// Pas de clé étrangère vers les données : la colonne métier (`documents.type`)
// stocke le CODE, pas l'identifiant — voir referentielType.model.js. Seule la
// portée par organisation est déclarée ici.
for (const Type of [TypeDocument, TypePartenaire, TypeInspection, CodeNiveau]) {
  Organisation.hasMany(Type, { foreignKey: 'organisationId', onDelete: 'CASCADE' });
  Type.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });
}

CorpsEtat.hasMany(Reserve, { foreignKey: 'corpsEtatId', as: 'reserves' });
Reserve.belongsTo(CorpsEtat, { foreignKey: 'corpsEtatId', as: 'corpsEtat' });

// Phase à laquelle la réserve est rattachée — voir phase.model.js : la même
// table porte les phases de planning (chantierId renseigné) et le référentiel
// (chantierId nul), et c'est ce dernier que visent les réserves.
Phase.hasMany(Reserve, { foreignKey: 'phaseId', as: 'reserves' });
Reserve.belongsTo(Phase, { foreignKey: 'phaseId', as: 'phase' });

Organisation.hasMany(Phase, { foreignKey: 'organisationId', as: 'phases', onDelete: 'CASCADE' });
Phase.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

Lot.hasMany(Reserve, { foreignKey: 'lotId', as: 'reserves' });
Reserve.belongsTo(Lot, { foreignKey: 'lotId', as: 'lot' });

// Entreprise en charge (organisation) + assigné + créateur
Reserve.belongsTo(Organisation, { foreignKey: 'entrepriseId', as: 'entreprise' });
Reserve.belongsTo(Utilisateur, { foreignKey: 'assigneA', as: 'assigne' });
Reserve.belongsTo(Utilisateur, { foreignKey: 'creePar', as: 'createur' });
Reserve.belongsTo(Utilisateur, { foreignKey: 'validePar', as: 'validateur' });

// Pièces jointes — module 5
Reserve.hasMany(PieceJointe, { foreignKey: 'reserveId', as: 'piecesJointes', onDelete: 'CASCADE' });
PieceJointe.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });
PieceJointe.belongsTo(Utilisateur, { foreignKey: 'uploaderId', as: 'uploader' });

// Affectations multiples — module 5
Reserve.hasMany(ReserveAffectation, { foreignKey: 'reserveId', as: 'affectations', onDelete: 'CASCADE' });
ReserveAffectation.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });
ReserveAffectation.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
ReserveAffectation.belongsTo(Organisation, { foreignKey: 'entrepriseId', as: 'entreprise' });
// L'annuaire du chantier — le destinataire le plus fréquent d'une affectation :
// la plupart des entreprises d'un chantier n'ont pas de compte sur la plateforme.
ReserveAffectation.belongsTo(Partenaire, { foreignKey: 'partenaireId', as: 'partenaire' });

// Position / médias / commentaires / historique
Reserve.hasOne(ReservePosition, { foreignKey: 'reserveId', as: 'position', onDelete: 'CASCADE' });
ReservePosition.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });

Reserve.hasMany(Media, { foreignKey: 'reserveId', as: 'medias', onDelete: 'CASCADE' });
Media.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });

Reserve.hasMany(Commentaire, { foreignKey: 'reserveId', as: 'commentaires', onDelete: 'CASCADE' });
Commentaire.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });
Commentaire.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'auteur' });

Reserve.hasMany(ReserveHistorique, { foreignKey: 'reserveId', as: 'historiques', onDelete: 'CASCADE' });
ReserveHistorique.belongsTo(Reserve, { foreignKey: 'reserveId', as: 'reserve' });
ReserveHistorique.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });

// ── Inspections & checklists & convocations ────────────────────────────────
Chantier.hasMany(Inspection, { foreignKey: 'chantierId', as: 'inspections', onDelete: 'CASCADE' });
Inspection.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });
Inspection.belongsTo(Utilisateur, { foreignKey: 'inspecteurId', as: 'inspecteur' });

Inspection.hasMany(Checklist, { foreignKey: 'inspectionId', as: 'checklist', onDelete: 'CASCADE' });
Checklist.belongsTo(Inspection, { foreignKey: 'inspectionId', as: 'inspection' });

// Photos d'inspection — module 6
Inspection.hasMany(Media, { foreignKey: 'inspectionId', as: 'photos', onDelete: 'CASCADE' });
Media.belongsTo(Inspection, { foreignKey: 'inspectionId', as: 'inspection' });

// Convocations — module 6
Inspection.hasMany(Convocation, { foreignKey: 'inspectionId', as: 'convocations', onDelete: 'CASCADE' });
Convocation.belongsTo(Inspection, { foreignKey: 'inspectionId', as: 'inspection' });
Convocation.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });

// Modèles de checklist — module 6
Organisation.hasMany(ChecklistModele, { foreignKey: 'organisationId', as: 'checklistModeles', onDelete: 'CASCADE' });
ChecklistModele.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });

// ── Documents ──────────────────────────────────────────────────────────────
Chantier.hasMany(Document, { foreignKey: 'chantierId', as: 'documents', onDelete: 'CASCADE' });
Document.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });
Document.belongsTo(Utilisateur, { foreignKey: 'uploaderId', as: 'uploader' });
Document.belongsTo(Utilisateur, { foreignKey: 'signataireId', as: 'signataire' });

// ── Rapports ───────────────────────────────────────────────────────────────
Chantier.hasMany(Rapport, { foreignKey: 'chantierId', as: 'rapports', onDelete: 'CASCADE' });
Rapport.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });
Rapport.belongsTo(Utilisateur, { foreignKey: 'generePar', as: 'generateur' });

// ── Partenaires (module 2) ─────────────────────────────────────────────────
Organisation.hasMany(Partenaire, { foreignKey: 'organisationId', as: 'partenaires', onDelete: 'CASCADE' });
Partenaire.belongsTo(Organisation, { foreignKey: 'organisationId', as: 'organisation' });
Chantier.hasMany(Partenaire, { foreignKey: 'chantierId', as: 'partenaires' });
Partenaire.belongsTo(Chantier, { foreignKey: 'chantierId', as: 'chantier' });

// « Entreprise concernée » d'une réserve — voir reserve.model.js#partenaireId.
Partenaire.hasMany(Reserve, { foreignKey: 'partenaireId', as: 'reserves' });
Reserve.belongsTo(Partenaire, { foreignKey: 'partenaireId', as: 'partenaire' });

// ── Signatures (module 5/7) — modèle polymorphe, lien au signataire ─────────
Signature.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'signataire' });
Utilisateur.hasMany(Signature, { foreignKey: 'utilisateurId', as: 'signatures' });

// ── Notifications ──────────────────────────────────────────────────────────
Utilisateur.hasMany(Notification, { foreignKey: 'utilisateurId', as: 'notifications', onDelete: 'CASCADE' });
Notification.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });

// ── Tokens / OTP / Device / Connexions ─────────────────────────────────────
RefreshToken.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
Utilisateur.hasMany(RefreshToken, { foreignKey: 'utilisateurId', as: 'refreshTokens', onDelete: 'CASCADE' });

UserOtp.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
Utilisateur.hasMany(UserOtp, { foreignKey: 'utilisateurId', as: 'otps', onDelete: 'CASCADE' });

DeviceToken.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
Utilisateur.hasMany(DeviceToken, { foreignKey: 'utilisateurId', as: 'deviceTokens', onDelete: 'CASCADE' });

// Historique des connexions — module 1
ConnexionLog.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
Utilisateur.hasMany(ConnexionLog, { foreignKey: 'utilisateurId', as: 'connexions', onDelete: 'CASCADE' });

// Challenges MFA — jetons à usage unique (anti rejeu + anti brute-force TOTP)
MfaChallenge.belongsTo(Utilisateur, { foreignKey: 'utilisateurId', as: 'utilisateur' });
Utilisateur.hasMany(MfaChallenge, { foreignKey: 'utilisateurId', as: 'mfaChallenges', onDelete: 'CASCADE' });

// `DemandeSuppression` n'a VOLONTAIREMENT aucune association : le demandeur
// n'est pas authentifié et peut n'avoir jamais eu de compte (voir l'en-tête du
// modèle). Une clé étrangère rejetterait la demande au lieu de l'enregistrer.

module.exports = {
  Utilisateur,
  Organisation,
  DemandeSuppression,
  Equipe,
  RefreshToken,
  UserOtp,
  DeviceToken,
  AuditLog,
  Chantier,
  Batiment,
  Etage,
  Zone,
  Lot,
  Plan,
  Reserve,
  ReservePosition,
  Media,
  Commentaire,
  ReserveHistorique,
  Inspection,
  Checklist,
  Document,
  Notification,
  Rapport,
  ConnexionLog,
  ChantierMembre,
  Phase,
  Annotation,
  PlanHotspot,
  CorpsEtat,
  TypeDocument,
  TypePartenaire,
  TypeInspection,
  CodeNiveau,
  PlanAbonnement,
  AbonnementSouscrit,
  EvenementPaiement,
  PieceJointe,
  Signature,
  ReserveAffectation,
  ChecklistModele,
  Convocation,
  Partenaire,
  MfaChallenge
};
