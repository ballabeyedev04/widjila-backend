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
const PieceJointe        = require('./pieceJointe.model.js');
const Signature          = require('./signature.model.js');
const ReserveAffectation = require('./reserveAffectation.model.js');
const ChecklistModele    = require('./checklistModele.model.js');
const Convocation        = require('./convocation.model.js');
const Partenaire         = require('./partenaire.model.js');
const MfaChallenge       = require('./mfaChallenge.model.js');

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

Zone.hasMany(Plan, { foreignKey: 'zoneId', as: 'plans' });
Plan.belongsTo(Zone, { foreignKey: 'zoneId', as: 'zone' });

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

module.exports = {
  Utilisateur,
  Organisation,
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
  PieceJointe,
  Signature,
  ReserveAffectation,
  ChecklistModele,
  Convocation,
  Partenaire,
  MfaChallenge
};
