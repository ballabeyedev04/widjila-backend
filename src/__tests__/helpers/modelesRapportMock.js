'use strict';

/**
 * Doubles des modèles Sequelize pour les tests du module Rapports.
 *
 * Le service Rapports touche une vingtaine de modèles. Les recopier dans
 * chaque fichier de test ferait diverger les doubles : l'un finirait par
 * oublier `bulkCreate`, et le test échouerait sur une méthode absente plutôt
 * que sur ce qu'il vérifie.
 *
 * Usage, dans un fichier de test :
 *
 *   jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());
 *   const modeles = require('../models/index.js');   // le MÊME objet, à régler
 */

let compteur = 0;

/**
 * Une ligne telle que Sequelize la rendrait : ses champs, plus `update`,
 * `destroy` et `toJSON`. `update` modifie l'objet EN PLACE, comme le vrai.
 */
function instance(valeurs = {}) {
  const ligne = { ...valeurs };
  // Non énumérables (un `toJSON` ou un `{ ...ligne }` ne doit pas les
  // recopier) mais REDÉFINISSABLES : un test peut vouloir faire échouer
  // `update` pour une valeur précise.
  const methode = (nom, valeur) => Object.defineProperty(ligne, nom, {
    enumerable: false, configurable: true, writable: true, value: valeur,
  });
  methode('update', jest.fn(async (champs) => Object.assign(ligne, champs)));
  methode('destroy', jest.fn(async () => {}));
  methode('toJSON', () => ({ ...ligne }));
  return ligne;
}

/** Un modèle doublé : toutes les méthodes utilisées par le module. */
function modele(nom) {
  return {
    nom,
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findByPk: jest.fn().mockResolvedValue(null),
    findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(async (v) => {
      compteur += 1;
      return instance({ id: `${nom.toLowerCase()}-${compteur}`, createdAt: new Date(), ...v });
    }),
    bulkCreate: jest.fn(async (lignes) => lignes),
    destroy: jest.fn(async () => 0),
    update: jest.fn(async () => [0]),
  };
}

const NOMS = [
  'Rapport', 'RapportFiltre', 'RapportDestinataire', 'RapportHistorique', 'RapportPartage',
  'Chantier', 'Organisation', 'Utilisateur', 'ChantierMembre', 'Partenaire', 'CorpsEtat',
  'Reserve', 'Batiment', 'Etage', 'Zone', 'Plan', 'Lot', 'Phase', 'Media',
  'ReservePosition', 'ReserveHistorique', 'Inspection', 'Convocation',
];

function creerModeles() {
  return Object.fromEntries(NOMS.map((nom) => [nom, modele(nom)]));
}

/** Remet toutes les méthodes des doubles à leur réponse neutre. */
function reinitialiser(modeles) {
  for (const m of Object.values(modeles)) {
    if (!m || typeof m !== 'object') continue;
    m.findAll.mockReset().mockResolvedValue([]);
    m.findOne.mockReset().mockResolvedValue(null);
    m.findByPk.mockReset().mockResolvedValue(null);
    m.findAndCountAll.mockReset().mockResolvedValue({ rows: [], count: 0 });
    m.count.mockReset().mockResolvedValue(0);
    m.bulkCreate.mockReset().mockImplementation(async (lignes) => lignes);
    m.destroy.mockReset().mockResolvedValue(0);
    m.create.mockReset().mockImplementation(async (v) => {
      compteur += 1;
      return instance({ id: `${m.nom.toLowerCase()}-${compteur}`, createdAt: new Date(), ...v });
    });
  }
}

module.exports = { creerModeles, reinitialiser, instance };
