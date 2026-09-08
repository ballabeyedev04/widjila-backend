'use strict';

/**
 * Tests — la localisation d'une réserve vient DU PLAN.
 *
 * ## Ce qui change
 *
 * On ne saisit plus « bâtiment, puis étage, puis zone » avant d'enregistrer un
 * défaut : on ouvre le plan concerné, on appuie à l'endroit exact, et c'est
 * fini. Le couple (`planId`, `position`) dit tout — le plan désigne le lieu, le
 * point y désigne l'endroit.
 *
 * ## Le piège
 *
 * Rien dans le reste de l'application n'a été réécrit pour se passer de
 * `batimentId` / `etageId` / `zoneId` : les rapports, les filtres, l'export
 * Excel et le tableau de bord regroupent tous par bâtiment et par étage.
 * Laisser ces trois champs vides viderait ces écrans pour toute réserve créée
 * depuis le nouveau parcours — une régression invisible tant qu'on ne regarde
 * pas un rapport.
 *
 * La règle testée ici est donc : le serveur DÉDUIT la localisation du plan, et
 * n'écrase jamais ce que l'appelant a envoyé lui-même.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Plan: { findByPk: jest.fn(), findOne: jest.fn() },
  Reserve: {},
  ReservePosition: {},
  ReserveHistorique: {},
  Chantier: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Media: {},
  Organisation: {},
  Utilisateur: {},
  Commentaire: {},
  Partenaire: {},
  CorpsEtat: {},
  Phase: {},
  ChantierMembre: {},
  Signature: {},
}));

jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn(),
}), { virtual: true });

const { Plan } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');
const { creerReserveSchema } = require('../modules/reserve/validation/reserve.validation.js');

const PLAN = '33333333-3333-4333-8333-333333333333';

/** Le plan tel qu'il est en base : rattaché à l'appartement A203. */
const planEnBase = {
  id: PLAN,
  batimentId: 'bat-A',
  etageId: 'etage-2',
  zoneId: 'zone-A203',
};

beforeEach(() => jest.clearAllMocks());

describe('la réserve hérite de la place de son plan', () => {
  it('recopie bâtiment, étage et zone du plan', async () => {
    Plan.findByPk.mockResolvedValue(planEnBase);

    const data = { planId: PLAN, titre: 'Fissure' };
    await ReserveService._heriterLocalisationDuPlan(data);

    expect(data.batimentId).toBe('bat-A');
    expect(data.etageId).toBe('etage-2');
    expect(data.zoneId).toBe('zone-A203');
  });

  it("n'écrase JAMAIS une localisation envoyée par l'appelant", async () => {
    // Les intégrations existantes — et l'import Excel — précisent encore
    // l'étage. Le leur remplacer par celui du plan changerait leur
    // comportement sans qu'elles aient rien demandé.
    Plan.findByPk.mockResolvedValue(planEnBase);

    const data = { planId: PLAN, titre: 'Fissure', etageId: 'etage-CHOISI' };
    await ReserveService._heriterLocalisationDuPlan(data);

    expect(data.etageId).toBe('etage-CHOISI');
    expect(Plan.findByPk).not.toHaveBeenCalled();
  });

  it('ne fait rien sans plan — une réserve peut naître hors de tout plan', async () => {
    // Un chantier dont les plans ne sont pas encore déposés doit rester
    // utilisable : c'est même le premier jour de chaque chantier.
    const data = { titre: 'Fissure' };
    await ReserveService._heriterLocalisationDuPlan(data);

    expect(data.batimentId).toBeUndefined();
    expect(Plan.findByPk).not.toHaveBeenCalled();
  });

  it("laisse la localisation vide quand le plan n'en a pas", async () => {
    // Le plan de masse d'un chantier dont la structure n'est pas saisie :
    // la réserve reste localisée par son plan et son point, ce qui est
    // exactement l'intention. On n'invente pas un bâtiment.
    Plan.findByPk.mockResolvedValue({ id: PLAN, batimentId: null, etageId: null, zoneId: null });

    const data = { planId: PLAN, titre: 'Fissure' };
    await ReserveService._heriterLocalisationDuPlan(data);

    expect(data.batimentId).toBeNull();
    expect(data.etageId).toBeNull();
    expect(data.zoneId).toBeNull();
  });

  it('reste sans effet si le plan a disparu entre-temps', async () => {
    // La vérification d'appartenance a déjà eu lieu (`_verifierLocalisation`) :
    // cette fonction ne doit ni refuser ni lever, seulement compléter.
    Plan.findByPk.mockResolvedValue(null);

    const data = { planId: PLAN, titre: 'Fissure' };
    await expect(ReserveService._heriterLocalisationDuPlan(data)).resolves.toBeDefined();
    expect(data.batimentId).toBeUndefined();
  });
});

describe('la position accepte les deux formes', () => {
  const BASE = {
    titre: 'Fissure au plafond',
    chantierId: '11111111-1111-4111-8111-111111111111',
    phaseId: '22222222-2222-4222-8222-222222222222',
    planId: PLAN,
  };

  it('accepte `positionX` / `positionY` à plat et les replie sur `position`', () => {
    // La forme naturelle pour une intégration : les coordonnées à côté de
    // `planId`, pas dans un sous-objet.
    const { error, value } = creerReserveSchema.validate({ ...BASE, positionX: 42.5, positionY: 66.7 });

    expect(error).toBeUndefined();
    expect(value.position).toEqual({ x: 42.5, y: 66.7, zoom: 1, page: 1 });
  });

  it("garde l'objet `position` quand les deux formes sont envoyées", () => {
    // La forme explicite l'emporte : c'est celle que produisent les clients
    // déjà en production.
    const { value } = creerReserveSchema.validate({
      ...BASE, position: { x: 1, y: 2 }, positionX: 90, positionY: 90,
    });

    expect(value.position).toEqual({ x: 1, y: 2, zoom: 1, page: 1 });
  });

  it('refuse une seule des deux coordonnées, avec un message lisible', () => {
    const { error } = creerReserveSchema.validate({ ...BASE, positionX: 42.5 });

    expect(error).toBeDefined();
    expect(error.message).toContain('positionX et positionY');
  });

  it('retient la PAGE du document, sur les deux formes', () => {
    // Cahier technique § 18 : « Plan multi-page → bonne page associée à la
    // réserve ». Sans elle, les repères d'un PDF de douze pages se dessinaient
    // tous sur la page affichée.
    expect(
      creerReserveSchema.validate({ ...BASE, position: { x: 1, y: 2, page: 7 } }).value.position.page,
    ).toBe(7);
    expect(
      creerReserveSchema.validate({ ...BASE, positionX: 1, positionY: 2, positionPage: 7 })
          .value.position.page,
    ).toBe(7);
  });

  it('refuse une page absurde', () => {
    // Une page 0 ou négative n'existe pas ; une page démesurée trahit une
    // erreur de calcul côté client.
    expect(creerReserveSchema.validate({ ...BASE, position: { x: 1, y: 2, page: 0 } }).error).toBeDefined();
    expect(creerReserveSchema.validate({ ...BASE, position: { x: 1, y: 2, page: -3 } }).error).toBeDefined();
  });

  it('borne la forme à plat comme la forme objet (0-100)', () => {
    expect(creerReserveSchema.validate({ ...BASE, positionX: 145, positionY: 50 }).error).toBeDefined();
    expect(creerReserveSchema.validate({ ...BASE, positionX: -1, positionY: 50 }).error).toBeDefined();
  });
});
