'use strict';

/**
 * Catalogue central des ÉNUMÉRATIONS métier.
 *
 * ── Pourquoi ce fichier ───────────────────────────────────────────────────
 * Ces listes existaient en SIX exemplaires : les modèles Sequelize, les
 * schémas Joi (`validations/common.js`, `document.validation.js`,
 * `partenaire.validation.js`, `rapport.validation.js`), l'export Excel, plus
 * une copie manuelle dans le web (`utils/constants.js`) et une autre dans le
 * mobile. Ajouter un statut demandait donc six modifications coordonnées, et
 * un oubli ne se voyait qu'à l'usage — un filtre qui ne propose pas la valeur,
 * un badge sans libellé.
 *
 * ── Ce que ce fichier N'EST PAS ───────────────────────────────────────────
 * Un référentiel administrable. Ces valeurs sont des ÉTATS de la logique
 * métier, pas des données :
 *
 *   - `TRANSITIONS` (reserve.service.js) code les passages autorisés entre
 *     statuts de réserve ;
 *   - `config/roles.js` construit les groupes de permissions sur les rôles ;
 *   - les colonnes sont des `ENUM` PostgreSQL : y ajouter une valeur demande
 *     une migration.
 *
 * Les rendre modifiables depuis l'administration casserait le produit à la
 * première suppression. Les VRAIS référentiels — corps d'état, phases,
 * formules d'abonnement — vivent en base et ont leur propre CRUD.
 *
 * ── Comment les clients les obtiennent ────────────────────────────────────
 * `GET /api/v1/referentiels/enums` sert ce fichier. Le web et le mobile le
 * consomment au lieu de recopier les listes ; les LIBELLÉS restent traduits
 * côté client, pour suivre la langue de l'utilisateur.
 *
 * ── Ajouter une valeur ────────────────────────────────────────────────────
 * 1. l'ajouter ici ;
 * 2. écrire la migration qui étend le type ENUM PostgreSQL correspondant ;
 * 3. ajouter sa traduction dans les quatre langues, web et mobile.
 */

// ── Utilisateurs ────────────────────────────────────────────────────────────
const ROLE_UTILISATEUR = [
  'Admin', 'ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise',
  'Client', 'MaitreOuvrage', 'MaitreOeuvre', 'Pilote', 'SousTraitant',
];

const STATUT_UTILISATEUR = ['actif', 'inactif', 'en_attente_validation', 'rejete'];

// ── Plans ───────────────────────────────────────────────────────────────────
//
// Un plan déposé avec une demande de chantier n'est pas encore exploitable :
// il attend la même validation que le chantier auquel il est joint. Sans ce
// statut, un plan en attente serait indiscernable d'un plan validé, et les
// équipes y poseraient des réserves sur un chantier qui n'existe pas encore.
const STATUT_PLAN = ['en_attente_validation', 'actif', 'rejete'];

// ── Niveaux ─────────────────────────────────────────────────────────────────
//
// Les trois SECTIONS de l'écran de dépôt de plans. Ce n'est pas une cote
// (`etages.niveau`, un entier) mais la nature du niveau : SS2 et R+2 ont des
// cotes opposées, et rien dans un entier ne dit qu'un niveau est une toiture.
const TYPE_NIVEAU = ['sous_sol', 'etage', 'toiture'];

// ── Chantiers ───────────────────────────────────────────────────────────────
// 'en_attente_validation' et 'rejete' encadrent la CREATION : tout chantier
// cree par un compte non-Admin y passe avant d'exister reellement. Ils sont
// places en tete parce qu'ils precedent 'en_preparation' dans le temps.
const STATUT_CHANTIER = [
  'en_attente_validation', 'rejete',
  'en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture',
];

// Statuts d'un chantier qui n'a PAS encore ete valide. Un tel chantier n'est
// pas un chantier en activite : il est ecarte des listes courantes, et n'est
// visible que par son demandeur et par ceux qui valident.
const STATUT_CHANTIER_EN_DEMANDE = ['en_attente_validation', 'rejete'];

// ── Réserves ────────────────────────────────────────────────────────────────
//
// L'ORDRE compte : il correspond à la progression du cycle de vie et sert au
// tri des colonnes de suivi. Ne pas réordonner sans vérifier les vues.
//
// Quatre statuts demandés par le client après la recette, sur le modèle de
// son outil de suivi précédent :
//   - `a_surveiller` : réserve ouverte placée sous surveillance ;
//   - `a_echeance`   : réserve ouverte dont l'échéance arrive ;
//   - `traitee`      : l'exécutant déclare la réserve traitée — même famille
//                      que `corrigee`, elle attend le verdict du contrôle ;
//   - `levee`        : verdict — la réserve est levée. Mêmes règles que
//                      `validee` (rôle de pilotage, preuves exigées).
// Les valeurs historiques gardent leur ordre relatif.
const STATUT_RESERVE = [
  'creee', 'affectee', 'prise_en_charge', 'en_cours', 'a_surveiller',
  'a_echeance', 'corrigee', 'traitee', 'a_verifier', 'validee', 'levee',
  'refusee', 'rouverte', 'en_retard', 'cloturee',
];

// Verdict POSITIF : la réserve est acceptée. Ce sont les « levées » des
// compteurs (taux de résolution, KPI) et les statuts qui exigent des preuves.
const STATUTS_RESERVE_LEVEES = ['validee', 'levee'];

// Réserve SOLDÉE : elle ne compte plus parmi les ouvertes, et elle est figée
// (ni modification, ni nouveau média). Une seule définition : elle existait en
// six copies (`['validee', 'cloturee']`), et l'ajout de `levee` aurait demandé
// de n'en oublier aucune.
const STATUTS_RESERVE_FERMES = [...STATUTS_RESERVE_LEVEES, 'cloturee'];

// Correction DÉCLARÉE par l'exécutant, en attente du verdict du contrôle.
// `traitee` est le mot du client pour `corrigee` ; `a_verifier` est l'étape
// suivante du même palier. Sert au rapport (« À contrôler ») et à la courbe
// d'évolution (« traitées »).
const STATUTS_RESERVE_TRAITEES = ['corrigee', 'traitee', 'a_verifier'];

// Libellés français des statuts, pour les textes composés côté serveur
// (notifications, exports). Les clients traduisent eux-mêmes les codes bruts.
const LIBELLE_STATUT_RESERVE = Object.freeze({
  creee: 'créée',
  affectee: 'affectée',
  prise_en_charge: 'prise en charge',
  en_cours: 'en cours',
  a_surveiller: 'à surveiller',
  a_echeance: 'à échéance',
  corrigee: 'corrigée',
  traitee: 'traitée',
  a_verifier: 'à vérifier',
  validee: 'validée',
  levee: 'levée',
  refusee: 'refusée',
  rouverte: 'rouverte',
  en_retard: 'en retard',
  cloturee: 'clôturée',
});

// Sévérité ET priorité partagent la même échelle, du plus faible au plus fort.
// L'ordre est utilisé pour les tris et le calcul des retards.
const SEVERITE_PRIORITE = ['faible', 'moyenne', 'haute', 'critique'];

/**
 * Catégories historiques de réserve.
 *
 * ⚠️ REMPLACÉES par le référentiel `corps_etat`, administrable et servi par
 * `/corps-etat/actifs`. Conservées parce que la colonne `reserve.categorie`
 * existe toujours en base, que les réserves anciennes la portent et que
 * l'export Excel s'appuie dessus. Les nouveaux écrans utilisent le corps
 * d'état ; ne pas proposer cette liste dans une interface de saisie.
 */
const CATEGORIE_RESERVE = [
  'maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage',
  'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre',
];

// ── Inspections ─────────────────────────────────────────────────────────────
const TYPE_INSPECTION = ['inspection', 'opr', 'visite_contradictoire'];
const STATUT_INSPECTION = ['planifiee', 'en_cours', 'terminee', 'signee'];
const STATUT_CONVOCATION = ['invite', 'accepte', 'decline', 'present', 'absent'];

// ── Documents ───────────────────────────────────────────────────────────────
const TYPE_DOCUMENT = [
  'plan', 'contrat', 'doe', 'pv', 'compte_rendu', 'rapport', 'notice',
  'photo', 'autre',
];
const STATUT_DOCUMENT = ['actif', 'archive'];

// ── Partenaires et organisations ────────────────────────────────────────────
const TYPE_PARTENAIRE = [
  'client', 'maitre_ouvrage', 'maitre_oeuvre', 'sous_traitant', 'fournisseur',
  'bureau_controle', 'autre',
];
const TYPE_ORGANISATION = ['entreprise', 'filiale', 'agence'];

// ── Plans et médias ─────────────────────────────────────────────────────────
const TYPE_PLAN = ['pdf', 'dwg', 'ifc'];
const TYPE_MEDIA = ['photo', 'video', 'audio'];
const CIBLE_HOTSPOT = ['batiment', 'etage', 'zone'];

// ── Abonnements ─────────────────────────────────────────────────────────────
//
// Les FORMULES elles-mêmes ne sont PAS ici : elles vivent en base
// (`plans_abonnement`), sont administrables et servies par `/abonnement/plans`.
// Seuls figurent ici les états techniques d'une souscription.
const PERIODE_ABONNEMENT = ['mois', 'an'];
const STATUT_SOUSCRIPTION = ['en_attente', 'active', 'echec', 'annulee', 'expiree'];

/**
 * Vue servie aux clients par `GET /referentiels/enums`.
 *
 * Les clés sont en camelCase — convention des réponses de cette API — et les
 * valeurs restent les codes bruts stockés en base : les libellés sont traduits
 * côté client.
 */
const VUE_PUBLIQUE = {
  roles: ROLE_UTILISATEUR,
  statutsUtilisateur: STATUT_UTILISATEUR,
  statutsChantier: STATUT_CHANTIER,
  statutsChantierEnDemande: STATUT_CHANTIER_EN_DEMANDE,
  statutsPlan: STATUT_PLAN,
  typesNiveau: TYPE_NIVEAU,
  statutsReserve: STATUT_RESERVE,
  severites: SEVERITE_PRIORITE,
  priorites: SEVERITE_PRIORITE,
  categoriesReserve: CATEGORIE_RESERVE,
  typesInspection: TYPE_INSPECTION,
  statutsInspection: STATUT_INSPECTION,
  statutsConvocation: STATUT_CONVOCATION,
  typesDocument: TYPE_DOCUMENT,
  statutsDocument: STATUT_DOCUMENT,
  typesPartenaire: TYPE_PARTENAIRE,
  typesOrganisation: TYPE_ORGANISATION,
  typesPlan: TYPE_PLAN,
  typesMedia: TYPE_MEDIA,
  ciblesHotspot: CIBLE_HOTSPOT,
  periodesAbonnement: PERIODE_ABONNEMENT,
  statutsSouscription: STATUT_SOUSCRIPTION,
};

module.exports = {
  ROLE_UTILISATEUR,
  STATUT_UTILISATEUR,
  STATUT_CHANTIER,
  STATUT_CHANTIER_EN_DEMANDE,
  STATUT_PLAN,
  TYPE_NIVEAU,
  STATUT_RESERVE,
  STATUTS_RESERVE_LEVEES,
  STATUTS_RESERVE_FERMES,
  STATUTS_RESERVE_TRAITEES,
  LIBELLE_STATUT_RESERVE,
  SEVERITE_PRIORITE,
  CATEGORIE_RESERVE,
  TYPE_INSPECTION,
  STATUT_INSPECTION,
  STATUT_CONVOCATION,
  TYPE_DOCUMENT,
  STATUT_DOCUMENT,
  TYPE_PARTENAIRE,
  TYPE_ORGANISATION,
  TYPE_PLAN,
  TYPE_MEDIA,
  CIBLE_HOTSPOT,
  PERIODE_ABONNEMENT,
  STATUT_SOUSCRIPTION,
  VUE_PUBLIQUE,
};
