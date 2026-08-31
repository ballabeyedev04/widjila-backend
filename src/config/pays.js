'use strict';

/**
 * Catalogue des PAYS et de leurs identifiants d'entreprise.
 *
 * ── Le problème résolu ────────────────────────────────────────────────────
 * Le formulaire d'inscription affichait SIRET, RCCM et NINEA en même temps,
 * quel que soit le pays. Une entreprise française se voyait donc demander un
 * NINEA — un identifiant sénégalais — et une entreprise malienne n'avait
 * nulle part où saisir son NIF.
 *
 * ── Source unique ─────────────────────────────────────────────────────────
 * Ce fichier décide, pour chaque pays, quels champs d'identification
 * s'affichent. Le backend valide d'après lui, et les deux clients le
 * consomment via `GET /referentiels/pays` : personne ne recopie la liste.
 *
 * ── Ce que chaque identifiant désigne ─────────────────────────────────────
 * Sénégal, Mali et Côte d'Ivoire sont membres de l'OHADA et partagent donc le
 * RCCM (Registre du Commerce et du Crédit Mobilier). Ce qui les distingue est
 * l'identifiant FISCAL, propre à chaque administration :
 *
 *   - France          SIRET (14 chiffres) + n° de TVA intracommunautaire
 *   - Sénégal         NINEA
 *   - Mali            NIF  — Numéro d'Identification Fiscale
 *   - Côte d'Ivoire   NCC  — Numéro de Compte Contribuable
 *                     IDU  — identifiant unique institué en 2015, qui a
 *                            vocation à remplacer RCCM et NCC. Les deux
 *                            systèmes coexistant encore, les trois champs
 *                            sont proposés et AUCUN n'est obligatoire.
 *
 * ── Aucun champ n'est obligatoire ─────────────────────────────────────────
 * Une entreprise en cours d'immatriculation n'a pas encore tous ses numéros.
 * Les rendre obligatoires l'empêcherait de s'inscrire. Ils sont donc
 * facultatifs, mais on refuse ceux qui n'ont pas de sens pour le pays choisi.
 */

/**
 * Champs d'identification connus.
 *
 * `cle` est la colonne du modèle `Organisation`. `motif` sert à la validation
 * côté serveur ET à la vérification de forme côté client — un seul endroit à
 * corriger si une administration change son format.
 */
const CHAMPS = {
  siret: {
    cle: 'siret',
    libelle: 'SIRET',
    // 14 chiffres exactement. Les espaces de saisie sont retirés en amont.
    motif: '^[0-9]{14}$',
    aide: '14 chiffres, sans espace',
  },
  num_tva: {
    cle: 'num_tva',
    libelle: 'N° TVA intracommunautaire',
    // FR + 2 caractères de clé + les 9 chiffres du SIREN.
    motif: '^FR[0-9A-Z]{2}[0-9]{9}$',
    aide: 'Par exemple FR12345678901',
  },
  rccm: {
    cle: 'rccm',
    libelle: 'RCCM',
    // Format OHADA très variable d'un greffe à l'autre : on contrôle la
    // longueur et le jeu de caractères, pas une structure qu'on inventerait.
    motif: '^[A-Za-z0-9/\\-. ]{4,50}$',
    aide: 'Registre du Commerce et du Crédit Mobilier',
  },
  ninea: {
    cle: 'ninea',
    libelle: 'NINEA',
    motif: '^[A-Za-z0-9]{5,15}$',
    aide: 'Numéro d’Identification National des Entreprises et Associations',
  },
  nif: {
    cle: 'nif',
    libelle: 'NIF',
    motif: '^[A-Za-z0-9]{5,20}$',
    aide: 'Numéro d’Identification Fiscale',
  },
  ncc: {
    cle: 'ncc',
    libelle: 'NCC',
    motif: '^[A-Za-z0-9]{5,20}$',
    aide: 'Numéro de Compte Contribuable',
  },
  idu: {
    cle: 'idu',
    libelle: 'IDU',
    motif: '^[A-Za-z0-9]{5,20}$',
    aide: 'Identifiant Unique (remplace progressivement RCCM et NCC)',
  },
};

/**
 * Pays proposés, et les champs d'identification de chacun.
 *
 * `code` suit la norme ISO 3166-1 alpha-2 : stable, universel, et déjà compris
 * par les bibliothèques de téléphone et d'adresse.
 */
const PAYS = [
  {
    code: 'FR',
    nom: 'France',
    indicatif: '+33',
    champs: ['siret', 'num_tva'],
  },
  {
    code: 'SN',
    nom: 'Sénégal',
    indicatif: '+221',
    champs: ['ninea', 'rccm'],
  },
  {
    code: 'ML',
    nom: 'Mali',
    indicatif: '+223',
    champs: ['nif', 'rccm'],
  },
  {
    code: 'CI',
    nom: 'Côte d’Ivoire',
    indicatif: '+225',
    // Les trois sont proposés : l'IDU a vocation à remplacer RCCM et NCC,
    // mais les deux systèmes coexistent encore sur le terrain.
    champs: ['rccm', 'ncc', 'idu'],
  },
];

/** Toutes les colonnes d'identification, tous pays confondus. */
const TOUS_CHAMPS = Object.keys(CHAMPS);

/** Pays par code, pour un accès direct. */
const PAR_CODE = Object.fromEntries(PAYS.map((p) => [p.code, p]));

/**
 * Champs autorisés pour un pays.
 *
 * Un code inconnu rend un tableau VIDE, pas la liste complète : mieux vaut ne
 * rien accepter que d'accepter n'importe quoi sur une valeur qu'on ne
 * reconnaît pas.
 */
function champsDuPays(codePays) {
  return PAR_CODE[codePays]?.champs ?? [];
}

/**
 * Vue servie aux clients par `GET /referentiels/pays`.
 *
 * Les libellés d'aide sont en français : ce sont des noms d'administrations,
 * qui ne se traduisent pas. Seul l'intitulé du pays est localisable côté
 * client, à partir de son code ISO.
 */
const VUE_PUBLIQUE = PAYS.map((p) => ({
  code: p.code,
  nom: p.nom,
  indicatif: p.indicatif,
  champs: p.champs.map((c) => CHAMPS[c]),
}));

module.exports = { CHAMPS, PAYS, PAR_CODE, TOUS_CHAMPS, champsDuPays, VUE_PUBLIQUE };
