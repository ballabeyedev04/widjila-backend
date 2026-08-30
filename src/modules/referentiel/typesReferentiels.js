'use strict';

const {
  TypeDocument, TypePartenaire, TypeInspection,
  Document, Partenaire, Inspection,
} = require('../../models/index.js');
const ReferentielTypeService = require('./service/referentielType.service.js');
const creerControleur = require('./controller/referentielType.controller.js');
const creerRouteur = require('./route/referentielType.route.js');

/**
 * Assemblage des trois référentiels de TYPE administrables.
 *
 * Chacun n'est qu'une CONFIGURATION : le modèle du catalogue, le modèle qui
 * porte le code dans ses données, et les libellés des messages. Le service,
 * le contrôleur et le routeur sont partagés — voir les fichiers du dossier.
 *
 * ── Ce que `modeleUsage` sert à faire ─────────────────────────────────────
 * Compter, avant une suppression, combien d'enregistrements portent le code.
 * C'est ce comptage qui fait refuser la suppression et proposer la
 * désactivation à la place : supprimer laisserait des documents avec un type
 * que plus rien ne décrit, et leur libellé disparaîtrait de l'écran.
 */

const DEFINITIONS = [
  {
    cle: 'document',
    chemin: '/types-document',
    modele: TypeDocument,
    modeleUsage: Document,
    colonneUsage: 'type',
    libelle: 'type de document',
    libelleAccord: 'Ce type de document',
    pluriel: 'Types de document',
  },
  {
    cle: 'partenaire',
    // « intervenant » côté interface, `partenaire` en base : le mot du métier
    // a changé, pas la table. Renommer la colonne aurait touché tous les
    // écrans pour un gain purement cosmétique.
    chemin: '/types-intervenant',
    modele: TypePartenaire,
    modeleUsage: Partenaire,
    colonneUsage: 'type',
    libelle: 'type d’intervenant',
    libelleAccord: 'Ce type d’intervenant',
    pluriel: 'Types d’intervenant',
  },
  {
    cle: 'inspection',
    chemin: '/types-inspection',
    modele: TypeInspection,
    modeleUsage: Inspection,
    colonneUsage: 'type',
    libelle: 'type d’inspection',
    libelleAccord: 'Ce type d’inspection',
    pluriel: 'Types d’inspection',
  },
];

const referentiels = DEFINITIONS.map((def) => {
  const service = new ReferentielTypeService(def);
  const controleur = creerControleur({ service, pluriel: def.pluriel });
  return { ...def, service, controleur, routeur: creerRouteur(controleur) };
});

/** Index par clé — utilisé par les validations métier (`codeValide`). */
const parCle = Object.fromEntries(referentiels.map((r) => [r.cle, r]));

module.exports = { referentiels, parCle };
