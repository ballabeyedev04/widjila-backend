'use strict';

/**
 * Tests — cohérence des requêtes Sequelize avec les modèles déclarés.
 *
 * ## Le défaut d'origine
 *
 * Deux pannes de production passaient à travers toute la suite : les autres
 * tests remplacent les modèles par des doublures, qui acceptent n'importe quel
 * include et n'importe quelle colonne.
 *   - « User is not associated to ChantierMembre! » : aucun rapport PDF ;
 *   - `chantierId` filtré sur `reserve_historiques`, qui n'a pas la colonne :
 *     le délai moyen de traitement échouait à chaque appel.
 *
 * ## Ce qui est verrouillé ici
 *
 * `scripts/auditRequetes.js` lit tout `src/` et confronte chaque requête aux
 * VRAIS modèles, sans base de données :
 *   1. chaque include vise une association déclarée ;
 *   2. chaque colonne citée (attributes, where, order) existe ;
 *   3. chaque mixin d'instance (getX, addX…) correspond à une association.
 *
 * En cas d'échec, le message donne le fichier, la ligne et la cause. Pour le
 * même rapport hors Jest : `npm run audit:requetes`.
 */

const path = require('path');
const sequelize = require('../config/db.js');
const { ChantierMembre } = require('../models/index.js');
const { auditer } = require('../../scripts/auditRequetes.js');

let rapport;

beforeAll(() => {
  rapport = auditer();
}, 60000);

afterAll(() => sequelize.close());

test('l’audit parcourt réellement le code', () => {
  // Garde-fou : un audit qui ne trouverait rien à lire passerait au vert
  // pour de mauvaises raisons.
  expect(rapport.fichiers).toBeGreaterThan(100);
  expect(rapport.verifies).toBeGreaterThan(1000);
});

test('chaque include vise une association déclarée, chaque colonne existe', () => {
  expect(rapport.erreurs).toEqual([]);
});

test('chaque mixin d’instance correspond à une association', () => {
  expect(rapport.mixins).toEqual([]);
});

test('le détecteur reconnaît une association manquante', () => {
  // On rejoue la panne d'origine : sans ce lien, l'audit DOIT la signaler.
  //
  // La requête visée vit désormais dans le service d'ENVOI des rapports : ce
  // sont les membres du chantier, proposés comme destinataires (§ 13 du
  // cahier des charges Rapports), qui se lisent par `ChantierMembre` →
  // `utilisateur`. Le document PDF, lui, ne liste plus les participants.
  const lien = ChantierMembre.associations.utilisateur;
  delete ChantierMembre.associations.utilisateur;
  try {
    const r = auditer({
      fichiers: [path.join(__dirname, '../modules/rapport/service/rapportEnvoi.service.js')],
    });
    expect(r.erreurs).toEqual([
      expect.stringMatching(/rapportEnvoi\.service\.js:\d+ .*not associated to ChantierMembre/),
    ]);
  } finally {
    ChantierMembre.associations.utilisateur = lien;
  }
});
