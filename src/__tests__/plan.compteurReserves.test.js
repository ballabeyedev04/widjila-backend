'use strict';

/**
 * Tests — le compteur de réserves des plans.
 *
 * ## Le besoin
 *
 * Sous le plan global, le mobile range les plans du chantier par bâtiment,
 * niveau et appartement, et affiche à côté de chacun « 5 réserves · 2 à
 * traiter ». Il charge pour cela `GET /chantiers/:id/plans` — la liste À PLAT,
 * qui ne portait aucun compteur : seules les racines et les sous-plans en
 * avaient.
 *
 * ## Ce que ces tests verrouillent
 *
 *  - la liste à plat porte désormais les compteurs, plan par plan ;
 *  - « à traiter » exclut les réserves validées et clôturées — la même règle
 *    que le rapport et le tableau de bord ;
 *  - le compte se fait par VERSION : une réserve reste sur la version où elle
 *    a été posée ;
 *  - UNE requête de réserves pour toute la liste, jamais une par plan.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Plan: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), max: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Batiment: { findOne: jest.fn(), findByPk: jest.fn() },
  Etage: { findByPk: jest.fn() },
  Zone: { findByPk: jest.fn() },
  Reserve: {},
  PlanHotspot: {},
  Annotation: {},
  Media: {},
}));

const sequelize = require('../config/db.js');
const { Plan, Chantier } = require('../models/index.js');
const PlanService = require('../modules/plan/service/plan.service.js');

const ORG = 'org-1';
const CHANTIER = '11111111-1111-4111-8111-111111111111';

/**
 * Répond aux deux agrégats du service — sous-plans et réserves —, reconnus à
 * la table qu'ils interrogent.
 */
function repondre({ sousPlans = [], reserves = [] } = {}) {
  sequelize.query.mockImplementation(async (sql) =>
    (sql.includes('FROM reserves') ? reserves : sousPlans));
}

/** Les requêtes posées sur la table des réserves. */
const requetesReserves = () =>
  sequelize.query.mock.calls.filter(([sql]) => sql.includes('FROM reserves'));

const plan = (id) => ({ id, chantierId: CHANTIER, nom: id, dataValues: {} });

beforeEach(() => {
  jest.clearAllMocks();
  Chantier.findOne.mockResolvedValue({ id: CHANTIER });
  repondre();
});

describe('la liste des plans d’un chantier porte ses compteurs', () => {
  it('le total ET ce qui reste à traiter, plan par plan', async () => {
    Plan.findAll.mockResolvedValue([plan('a001'), plan('a002')]);
    repondre({ reserves: [{ planId: 'a001', total: 5, aTraiter: 2 }] });

    const r = await PlanService.listPlans(ORG, CHANTIER);

    expect(r.success).toBe(true);
    expect(r.plans[0].dataValues).toEqual(
      expect.objectContaining({ nombre_reserves: 5, nombre_reserves_a_traiter: 2 })
    );
    // Un plan sans réserve n'est pas absent de la réponse : il vaut 0.
    expect(r.plans[1].dataValues).toEqual(
      expect.objectContaining({ nombre_reserves: 0, nombre_reserves_a_traiter: 0 })
    );
  });

  it('« à traiter » exclut les réserves validées et clôturées', async () => {
    Plan.findAll.mockResolvedValue([plan('a001')]);

    await PlanService.listPlans(ORG, CHANTIER);

    const [[sql, options]] = requetesReserves();
    expect(sql).toContain('FILTER (WHERE statut NOT IN (:leves))');
    expect(options.replacements.leves).toEqual(['validee', 'cloturee']);
    // Une réserve supprimée ne compte ni dans le total ni dans le reste.
    expect(sql).toContain('deleted_at IS NULL');
  });

  it('compte par VERSION : une réserve reste sur la version où elle a été posée', async () => {
    Plan.findAll.mockResolvedValue([plan('v2'), plan('v1')]);
    repondre({ reserves: [{ planId: 'v1', total: 3, aTraiter: 1 }] });

    const r = await PlanService.listPlans(ORG, CHANTIER);

    const parVersion = Object.fromEntries(r.plans.map((p) => [p.id, p.dataValues.nombre_reserves]));
    expect(parVersion).toEqual({ v2: 0, v1: 3 });
  });

  it('UNE requête de réserves pour toute la liste, jamais une par plan', async () => {
    Plan.findAll.mockResolvedValue([plan('a'), plan('b'), plan('c'), plan('d')]);

    await PlanService.listPlans(ORG, CHANTIER);

    expect(requetesReserves()).toHaveLength(1);
  });

  it('refuse un chantier hors de l’organisation, sans rien compter', async () => {
    Chantier.findOne.mockResolvedValue(null);

    const r = await PlanService.listPlans(ORG, CHANTIER);

    expect(r.success).toBe(false);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  it('un chantier sans plan ne pose aucune requête d’agrégat', async () => {
    Plan.findAll.mockResolvedValue([]);

    const r = await PlanService.listPlans(ORG, CHANTIER);

    expect(r.plans).toEqual([]);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('les racines portent aussi « à traiter »', () => {
  it('même forme d’objet que la liste à plat', async () => {
    Plan.findAll.mockResolvedValue([plan('global')]);
    repondre({ reserves: [{ planId: 'global', total: 4, aTraiter: 4 }] });

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.plans[0].dataValues).toEqual(
      expect.objectContaining({ nombre_reserves: 4, nombre_reserves_a_traiter: 4 })
    );
  });
});
