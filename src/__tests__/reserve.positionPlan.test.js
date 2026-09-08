'use strict';

/**
 * Tests — les coordonnées d'une réserve sur un plan.
 *
 * ## Le défaut
 *
 * `x` et `y` n'avaient AUCUNE borne côté serveur. Les deux clients bornent
 * pourtant leur saisie — le mobile dans `plan_interactif.dart`, le web dans
 * `PlanCanvas.jsx`. Mais une garde qui ne vit que chez le client ne garde
 * rien : un appel direct, une version plus ancienne de l'application ou une
 * future intégration suffisent à écrire `x = 1450`.
 *
 * Une réserve hors bornes est dessinée hors du plan : invisible, ou plaquée
 * contre un bord au mauvais endroit. Personne ne la retrouve, et rien ne
 * signale l'anomalie — c'est le pire des cas, une donnée fausse qui se tait.
 *
 * ## L'échelle
 *
 * 0-100, en POURCENTAGES de l'image, et non 0-1. C'est l'échelle réellement
 * utilisée par les deux clients et par les données déjà en base. Ce qui compte
 * est que la valeur soit RELATIVE à l'image — un pourcentage l'est autant
 * qu'une fraction.
 */

const {
  creerReserveSchema,
  modifierReserveSchema,
} = require('../modules/reserve/validation/reserve.validation.js');

const BASE = {
  titre: 'Fissure au plafond',
  chantierId: '11111111-1111-4111-8111-111111111111',
  phaseId: '22222222-2222-4222-8222-222222222222',
};

const creer = (position) => creerReserveSchema.validate({ ...BASE, position });

describe('les positions acceptées', () => {
  it.each([
    ['un point quelconque', 42, 67],
    ['le coin haut gauche', 0, 0],
    ['le coin bas droit', 100, 100],
    ['des décimales', 42.37, 66.91],
  ])('accepte %s', (_libelle, x, y) => {
    expect(creer({ x, y }).error).toBeUndefined();
  });

  it('accepte une réserve SANS position', () => {
    // Un chantier dont les plans ne sont pas encore déposés ne doit pas
    // empêcher de relever une réserve. La position reste facultative.
    expect(creerReserveSchema.validate(BASE).error).toBeUndefined();
  });
});

describe('les positions refusées', () => {
  it.each([
    ['au-delà du bord droit', 145, 50],
    ['au-delà du bord bas', 50, 101],
    ['avant le bord gauche', -5, 50],
    ['avant le bord haut', 50, -0.5],
  ])('refuse un point %s', (_libelle, x, y) => {
    expect(creer({ x, y }).error).toBeDefined();
  });

  it("refuse une position incomplète", () => {
    // Une abscisse sans ordonnée ne place rien : mieux vaut refuser que
    // d'enregistrer un repère à moitié défini.
    expect(creer({ x: 42 }).error).toBeDefined();
    expect(creer({ y: 42 }).error).toBeDefined();
  });

  it('refuse un zoom nul ou négatif', () => {
    // Le zoom est conservé à titre indicatif ; une valeur nulle trahit une
    // erreur de calcul chez l'appelant.
    expect(creer({ x: 42, y: 67, zoom: 0 }).error).toBeDefined();
    expect(creer({ x: 42, y: 67, zoom: -2 }).error).toBeDefined();
  });
});

describe('la modification suit la même règle', () => {
  // Deux chemins mènent à la même écriture : une borne posée sur un seul
  // des deux ne borne rien.
  it('refuse une position hors bornes', () => {
    expect(modifierReserveSchema.validate({ position: { x: 300, y: 10 } }).error).toBeDefined();
  });

  it('accepte une position valide', () => {
    expect(modifierReserveSchema.validate({ position: { x: 30, y: 10 } }).error).toBeUndefined();
  });
});
