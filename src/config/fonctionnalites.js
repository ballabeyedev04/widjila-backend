'use strict';

/**
 * Catalogue des fonctionnalités soumises à l'abonnement.
 *
 * ── Ce que ce fichier EST ─────────────────────────────────────────────────
 * La liste des codes reconnus, et leur libellé. C'est le vocabulaire commun au
 * backend, à l'espace d'administration, au web et au mobile.
 *
 * ── Ce que ce fichier N'EST PAS ───────────────────────────────────────────
 * Il ne dit PAS quelle formule ouvre quoi : cette affectation vit en base
 * (`plans_abonnement.fonctionnalites`) et se change depuis l'administration,
 * sans livraison. Un code absent de la liste ci-dessous n'ouvre rien et ne
 * casse rien — il est simplement ignoré.
 *
 * ── Source ────────────────────────────────────────────────────────────────
 * Les codes reprennent les intitulés commerciaux fournis par le client
 * (présentation commerciale + visuel des formules). Ils ne sont pas inventés.
 */

/**
 * Fonctionnalités incluses dans TOUTES les formules d'après le visuel client.
 * Elles ne gardent aucun endpoint : elles servent à l'affichage des offres.
 * Les inscrire quand même évite qu'une future formule « allégée » ait à
 * inventer un code au moment où on voudra les retirer.
 */
const SOCLE = {
  reserves: 'Gestion des réserves',
  mobile: 'Application mobile & tablette',
  stockage: 'Stockage sécurisé',
  support_prioritaire: 'Support prioritaire',
};

/**
 * Options avancées — « offert en Pro & Entreprise » d'après le visuel client.
 * Ce sont ELLES qui gardent réellement des endpoints.
 */
const AVANCEES = {
  /**
   * Gestion des membres et des équipes de l'organisation.
   * Garde : `/organisation/membres`, `/organisation/equipes`.
   */
  suivi_equipe: 'Suivi d’équipe',

  /**
   * Génération de rapports PDF.
   *
   * Garde : `POST /chantiers/:chantierId/rapports/generer` UNIQUEMENT.
   *
   * Ni la liste ni la lecture d'un rapport ne sont gardées : un document déjà
   * produit a été payé sous la formule d'alors, le fermer rétroactivement
   * reviendrait à reprendre une livraison. Le tableau de bord n'est pas gardé
   * non plus — c'est l'écran d'accueil, et « Gestion des réserves » qu'il
   * résume figure dans le socle commun.
   */
  rapports: 'Rapports et statistiques',

  /**
   * ANNOTATION des plans : marqueurs, cotes, zones cliquables.
   *
   * ⚠️ INTERPRÉTATION À CONFIRMER. Le visuel client range « Plans &
   * Annotations » dans les options avancées. Pris au pied de la lettre, une
   * formule Essentiel n'aurait aucun accès aux plans — or créer une réserve
   * en cliquant sur un plan est le cœur du produit, et « Gestion des
   * réserves » figure dans le socle commun. Fermer les plans à Essentiel
   * viderait donc sa fonctionnalité principale.
   *
   * On garde par conséquent l'ANNOTATION (annotations, hotspots), pas la
   * consultation ni le dépôt de plans. À trancher avec le client.
   */
  annotations: 'Plans & annotations',

  /**
   * Intégrations API tierces.
   *
   * ⚠️ Le produit n'expose aujourd'hui AUCUNE API publique : ce code ne garde
   * donc rien pour l'instant. Il est déclaré pour que l'offre commerciale
   * puisse l'afficher, et pour que la garde existe le jour où l'API arrive.
   */
  api: 'Intégrations API',
};

const FONCTIONNALITES = { ...SOCLE, ...AVANCEES };

/** Codes reconnus — tout le reste est ignoré. */
const CODES = Object.keys(FONCTIONNALITES);

/** Vrai si le code fait partie du catalogue. */
const estConnue = (code) => Object.prototype.hasOwnProperty.call(FONCTIONNALITES, code);

/** Libellé affichable d'un code, ou le code lui-même s'il est inconnu. */
const libelle = (code) => FONCTIONNALITES[code] || code;

module.exports = {
  FONCTIONNALITES,
  SOCLE,
  AVANCEES,
  CODES,
  estConnue,
  libelle,
};
