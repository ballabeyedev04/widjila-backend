'use strict';

/**
 * Référentiel du module Rapports — le vocabulaire du cahier des charges,
 * traduit vers les données réellement stockées.
 *
 * ── Pourquoi ce fichier existe ─────────────────────────────────────────────
 *
 * Le cahier des charges parle de cinq statuts (« À traiter, En cours, À
 * contrôler, Levée, Clôturée ») et de trois gravités (« Critique, Majeure,
 * Mineure »). La base, elle, connaît onze statuts de réserve et quatre
 * sévérités : ce sont deux vocabulaires différents, et la traduction doit
 * exister à UN SEUL endroit. Dispersée, elle finirait par diverger — le
 * filtre compterait une réserve que la synthèse rangerait ailleurs, et un
 * rapport se contredirait lui-même.
 *
 * ── Règle de traduction ────────────────────────────────────────────────────
 *
 * Chaque statut de la base appartient à EXACTEMENT un statut de rapport, et
 * chaque sévérité à exactement une gravité : la somme des colonnes de la
 * synthèse est donc toujours égale au total. `verifierCouverture()` en bas de
 * fichier le vérifie au chargement — un statut ajouté à l'ENUM sans être
 * classé ici ferait disparaître des réserves du rapport, silencieusement.
 */

const { STATUT_RESERVE, SEVERITE_PRIORITE } = require('../../../config/enums.js');

/* ══════════════════════════════════════════════════════════════════════════
   § 4 — Statuts du rapport
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Les cinq statuts du cahier des charges, et les statuts de réserve qu'ils
 * recouvrent.
 *
 * `refusee` et `rouverte` sont rangés dans « À traiter » : dans les deux cas
 * la correction est à refaire, et personne n'y travaille à cet instant.
 * `en_retard` y est aussi — c'est un « à traiter » qui a dépassé sa date, pas
 * un état d'avancement.
 */
const STATUTS_RAPPORT = {
  A_TRAITER: {
    libelle: 'À traiter',
    statuts: ['creee', 'affectee', 'refusee', 'rouverte', 'en_retard'],
  },
  EN_COURS: {
    libelle: 'En cours',
    statuts: ['prise_en_charge', 'en_cours'],
  },
  A_CONTROLER: {
    libelle: 'À contrôler',
    statuts: ['corrigee', 'a_verifier'],
  },
  LEVEE: {
    libelle: 'Levée',
    statuts: ['validee'],
  },
  CLOTUREE: {
    libelle: 'Clôturée',
    statuts: ['cloturee'],
  },
};

const CODES_STATUT_RAPPORT = Object.keys(STATUTS_RAPPORT);

/** Statuts considérés comme LEVÉS — la réserve n'appelle plus d'action. */
const STATUTS_LEVES = [...STATUTS_RAPPORT.LEVEE.statuts, ...STATUTS_RAPPORT.CLOTUREE.statuts];

/** Index inverse : statut de réserve → code de statut de rapport. */
const STATUT_RESERVE_VERS_RAPPORT = Object.freeze(
  Object.entries(STATUTS_RAPPORT).reduce((index, [code, def]) => {
    for (const statut of def.statuts) index[statut] = code;
    return index;
  }, {}),
);

/** Code de statut de rapport d'une réserve, ou `null` si son statut est inconnu. */
function statutRapportDe(statutReserve) {
  return STATUT_RESERVE_VERS_RAPPORT[statutReserve] || null;
}

/** Libellé affichable d'un statut de rapport. */
function libelleStatutRapport(code) {
  return STATUTS_RAPPORT[code]?.libelle || code;
}

/** Statuts de réserve couverts par une sélection de statuts de rapport. */
function statutsReservePour(codes = []) {
  const sortie = [];
  for (const code of codes) {
    const def = STATUTS_RAPPORT[code];
    if (def) sortie.push(...def.statuts);
  }
  return [...new Set(sortie)];
}

/* ══════════════════════════════════════════════════════════════════════════
   § 4 — Gravités
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Les trois gravités du cahier des charges.
 *
 * La base distingue quatre sévérités ; « moyenne » et « faible » relèvent
 * toutes deux du « Mineure » demandé. Une réserve sans sévérité renseignée
 * n'est rattachée à AUCUNE gravité : elle est comptée à part (« Non
 * renseignée ») plutôt que rangée d'office en mineure, ce qui reviendrait à
 * décider à la place de celui qui l'a créée.
 */
const GRAVITES = {
  CRITIQUE: { libelle: 'Critique', severites: ['critique'] },
  MAJEURE: { libelle: 'Majeure', severites: ['haute'] },
  MINEURE: { libelle: 'Mineure', severites: ['moyenne', 'faible'] },
};

const CODES_GRAVITE = Object.keys(GRAVITES);

const SEVERITE_VERS_GRAVITE = Object.freeze(
  Object.entries(GRAVITES).reduce((index, [code, def]) => {
    for (const severite of def.severites) index[severite] = code;
    return index;
  }, {}),
);

function graviteDe(severite) {
  return SEVERITE_VERS_GRAVITE[severite] || null;
}

function libelleGravite(code) {
  return GRAVITES[code]?.libelle || code;
}

function severitesPour(codes = []) {
  const sortie = [];
  for (const code of codes) {
    const def = GRAVITES[code];
    if (def) sortie.push(...def.severites);
  }
  return [...new Set(sortie)];
}

/* ══════════════════════════════════════════════════════════════════════════
   Libellés des données de la base
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Statut DÉTAILLÉ d'une réserve.
 *
 * Le rapport affiche le statut du cahier des charges (« À traiter »), mais
 * garde le détail à côté (« Refusée ») : les deux réserves sont à traiter, et
 * l'entreprise n'a pas le même travail devant elle selon que sa correction a
 * été refusée ou qu'elle n'a jamais commencé.
 */
const LIBELLE_STATUT_RESERVE = {
  creee: 'Créée', affectee: 'Affectée', prise_en_charge: 'Prise en charge',
  en_cours: 'En cours', corrigee: 'Corrigée', a_verifier: 'À vérifier',
  validee: 'Validée', refusee: 'Refusée', rouverte: 'Rouverte',
  en_retard: 'En retard', cloturee: 'Clôturée',
};

const LIBELLE_SEVERITE = {
  faible: 'Faible', moyenne: 'Moyenne', haute: 'Haute', critique: 'Critique',
};

/** Actions de l'historique d'une RÉSERVE (`reserve_historiques.action`). */
const LIBELLE_ACTION_RESERVE = {
  creation: 'Création', modification: 'Modification', statut: 'Changement de statut',
  commentaire: 'Commentaire', validation: 'Validation', refus: 'Refus',
  rouverture: 'Réouverture', cloture: 'Clôture', suppression: 'Suppression',
};

/**
 * Statuts qui marquent une CORRECTION DÉCLARÉE par l'entreprise.
 *
 * C'est le pivot du § 17 : la date à laquelle la réserve passe dans l'un de
 * ces statuts sépare les photos « avant » des photos « après ».
 */
const STATUTS_CORRECTION = ['corrigee', 'a_verifier'];

/* ══════════════════════════════════════════════════════════════════════════
   § 5 — Modèles de rapport
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Sections configurables — exactement celles du § 10 du cahier des charges.
 *
 *   summary  : la page de synthèse (§ 6, page 2)
 *   plans    : l'extrait de plan de chaque réserve
 *   photos   : les photographies de chaque réserve
 *   location : la localisation (bâtiment / étage / appartement) et la pastille
 *   history  : l'historique de chaque réserve
 */
const SECTIONS = ['summary', 'plans', 'photos', 'location', 'history'];

const SECTIONS_PAR_DEFAUT = Object.freeze({
  summary: true,
  plans: true,
  photos: true,
  location: true,
  history: false,
});

/** Formats de sortie (§ 4 et § 10). */
const FORMATS = ['PDF', 'XLSX'];

/**
 * Les modèles du § 5.
 *
 * `filtresRequis` empêche un document vide de sens : un « rapport par
 * bâtiment » sans bâtiment choisi n'est pas un rapport par bâtiment, c'est un
 * rapport global mal nommé — et il partirait aux entreprises sous ce titre.
 *
 * `groupement` décide de l'ordre des fiches dans le PDF ; `fiche` choisit la
 * mise en page d'une réserve (`standard`, ou `levee` pour le § 17).
 */
const MODELES = {
  GLOBAL: {
    id: 'GLOBAL',
    libelle: 'Rapport global du chantier',
    description: 'Toutes les réserves du chantier, groupées par localisation.',
    filtresRequis: [],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'localisation',
    fiche: 'standard',
  },
  BATIMENT: {
    id: 'BATIMENT',
    libelle: 'Rapport par bâtiment',
    description: 'Les réserves d’un bâtiment, groupées par étage.',
    filtresRequis: ['batiment'],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'etage',
    fiche: 'standard',
  },
  ETAGE_ZONE: {
    id: 'ETAGE_ZONE',
    libelle: 'Rapport par étage / zone',
    description: 'Les réserves d’un ou plusieurs niveaux, ou d’appartements précis.',
    filtresRequis: ['etage_ou_zone'],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'localisation',
    fiche: 'standard',
  },
  ENTREPRISE: {
    id: 'ENTREPRISE',
    libelle: 'Rapport par entreprise',
    description: 'Les réserves d’une entreprise, groupées par localisation.',
    filtresRequis: ['entreprise'],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'entreprise',
    fiche: 'standard',
  },
  CORPS_ETAT: {
    id: 'CORPS_ETAT',
    libelle: 'Rapport par corps d’état',
    description: 'Les réserves d’un ou plusieurs métiers.',
    filtresRequis: ['corps_etat'],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'corps_etat',
    fiche: 'standard',
  },
  A_TRAITER: {
    id: 'A_TRAITER',
    libelle: 'Rapport des réserves à traiter',
    description: 'Les réserves non levées, classées par échéance.',
    filtresRequis: [],
    // Le modèle POSE le périmètre : sans cela, « réserves à traiter » serait
    // un titre, pas un filtre. L'utilisateur peut ensuite le restreindre.
    filtresParDefaut: { statuts: ['A_TRAITER', 'EN_COURS', 'A_CONTROLER'] },
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'echeance',
    fiche: 'standard',
  },
  LEVEES: {
    id: 'LEVEES',
    libelle: 'Rapport des réserves levées',
    description: 'Les réserves levées : état initial, correction, contrôle et validation.',
    filtresRequis: [],
    filtresParDefaut: { statuts: ['LEVEE', 'CLOTUREE'] },
    // L'historique est ALLUMÉ par défaut : le § 17 demande de montrer qui a
    // demandé la levée et qui l'a contrôlée, ce qui vient de l'historique.
    sectionsParDefaut: { ...SECTIONS_PAR_DEFAUT, history: true },
    groupement: 'entreprise',
    fiche: 'levee',
  },
  OPR: {
    id: 'OPR',
    libelle: 'Rapport OPR / réception',
    description: 'Le procès-verbal d’opérations préalables à la réception.',
    filtresRequis: [],
    filtresParDefaut: {},
    sectionsParDefaut: SECTIONS_PAR_DEFAUT,
    groupement: 'localisation',
    fiche: 'standard',
    // Un PV de réception se signe : le document réserve la place pour cela.
    signatures: true,
  },
};

const CODES_MODELE = Object.keys(MODELES);

/**
 * Modèles annoncés par le cahier des charges pour PLUS TARD.
 *
 * Les nommer permet de refuser proprement (« prévu dans une version
 * ultérieure ») plutôt que de répondre « modèle inconnu », ce qui laisserait
 * croire à une faute de frappe.
 */
const MODELES_VERSION_ULTERIEURE = { SAV: 'Rapport SAV' };

function modele(id) {
  return MODELES[String(id || '').toUpperCase()] || null;
}

/* ══════════════════════════════════════════════════════════════════════════
   § 19 — États techniques du rapport
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Les sept états du § 19. Stockés en minuscules sans accent — une valeur de
 * base de données se lit dans des journaux, des index et des URL.
 */
const ETATS = {
  BROUILLON: 'brouillon',
  EN_ATTENTE: 'en_attente',
  GENERATION: 'generation',
  GENERE: 'genere',
  ENVOYE: 'envoye',
  ECHEC: 'echec',
  ARCHIVE: 'archive',
};

const CODES_ETAT = Object.values(ETATS);

const LIBELLE_ETAT = {
  brouillon: 'Brouillon',
  en_attente: 'En attente',
  generation: 'Génération',
  genere: 'Généré',
  envoye: 'Envoyé',
  echec: 'Échec',
  archive: 'Archivé',
};

/* ══════════════════════════════════════════════════════════════════════════
   § 18 — Actions journalisées
   ══════════════════════════════════════════════════════════════════════════ */

const ACTIONS_HISTORIQUE = {
  CREE: 'cree',
  MODIFIE: 'modifie',
  GENERE: 'genere',
  ECHEC: 'echec',
  TELECHARGE: 'telecharge',
  ENVOYE: 'envoye',
  PARTAGE: 'partage',
  PARTAGE_REVOQUE: 'partage_revoque',
  CONSULTE_VIA_LIEN: 'consulte_via_lien',
  DUPLIQUE: 'duplique',
  NOUVELLE_VERSION: 'nouvelle_version',
  ARCHIVE: 'archive',
};

const LIBELLE_ACTION = {
  cree: 'Rapport créé',
  modifie: 'Configuration modifiée',
  genere: 'PDF généré',
  echec: 'Échec de génération',
  telecharge: 'Rapport téléchargé',
  envoye: 'Rapport envoyé',
  partage: 'Lien de partage créé',
  partage_revoque: 'Lien de partage révoqué',
  consulte_via_lien: 'Rapport consulté via lien',
  duplique: 'Rapport dupliqué',
  nouvelle_version: 'Nouvelle version générée',
  archive: 'Rapport archivé',
};

/* ══════════════════════════════════════════════════════════════════════════
   Traductions vers l'existant
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Les anciens types de rapport (`reserves`, `visite`, `opr`…) vers les modèles
 * du cahier des charges.
 *
 * L'ancien point d'entrée — celui qu'utilisent l'espace web et les versions du
 * mobile déjà installées — continue de fonctionner en passant par ici. Sans
 * cette table, une mise à jour du serveur casserait tous les clients qui n'ont
 * pas encore été mis à jour.
 */
const TYPE_LEGACY_VERS_MODELE = {
  reserves: 'GLOBAL',
  entreprise: 'ENTREPRISE',
  batiment: 'BATIMENT',
  qualite: 'GLOBAL',
  visite: 'GLOBAL',
  opr: 'OPR',
};

const MODELE_VERS_TYPE_LEGACY = {
  GLOBAL: 'reserves',
  BATIMENT: 'batiment',
  ETAGE_ZONE: 'batiment',
  ENTREPRISE: 'entreprise',
  CORPS_ETAT: 'reserves',
  A_TRAITER: 'reserves',
  LEVEES: 'reserves',
  OPR: 'opr',
};

/* ══════════════════════════════════════════════════════════════════════════
   Garde-fou : aucune donnée ne doit sortir du classement
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Vérifie que TOUT statut de l'ENUM et TOUTE sévérité sont classés.
 *
 * Exécuté au chargement du module : un statut ajouté à `config/enums.js` sans
 * être rangé ici sortirait sinon des filtres et des comptages — les réserves
 * concernées disparaîtraient du rapport sans que rien ne le signale.
 */
function verifierCouverture() {
  const classes = new Set(Object.keys(STATUT_RESERVE_VERS_RAPPORT));
  const orphelins = (STATUT_RESERVE || []).filter((s) => !classes.has(s));
  if (orphelins.length) {
    throw new Error(
      `[rapport] Statuts de réserve non classés dans le référentiel : ${orphelins.join(', ')}`,
    );
  }

  const severitesClassees = new Set(Object.keys(SEVERITE_VERS_GRAVITE));
  const severitesOrphelines = (SEVERITE_PRIORITE || []).filter((s) => !severitesClassees.has(s));
  if (severitesOrphelines.length) {
    throw new Error(
      `[rapport] Sévérités non classées dans le référentiel : ${severitesOrphelines.join(', ')}`,
    );
  }
}

verifierCouverture();

module.exports = {
  STATUTS_RAPPORT,
  CODES_STATUT_RAPPORT,
  STATUTS_LEVES,
  statutRapportDe,
  libelleStatutRapport,
  statutsReservePour,

  GRAVITES,
  CODES_GRAVITE,
  graviteDe,
  libelleGravite,
  severitesPour,

  LIBELLE_STATUT_RESERVE,
  LIBELLE_SEVERITE,
  LIBELLE_ACTION_RESERVE,
  STATUTS_CORRECTION,

  MODELES,
  CODES_MODELE,
  MODELES_VERSION_ULTERIEURE,
  modele,
  SECTIONS,
  SECTIONS_PAR_DEFAUT,
  FORMATS,

  ETATS,
  CODES_ETAT,
  LIBELLE_ETAT,

  ACTIONS_HISTORIQUE,
  LIBELLE_ACTION,

  TYPE_LEGACY_VERS_MODELE,
  MODELE_VERS_TYPE_LEGACY,

  verifierCouverture,
};
