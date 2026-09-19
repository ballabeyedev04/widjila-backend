'use strict';

/**
 * Tests — numérotation des réserves PAR PLAN (`numeroPlan`).
 *
 * Sur un plan, plusieurs repères rouges ne disent pas laquelle des réserves a
 * été relevée en premier. Le numéro de chantier (`R-0031`) ne l'aide pas non
 * plus : il court sur tout le chantier. Chaque réserve posée sur un plan reçoit
 * donc un second numéro, entier, qui repart à 1 sur CHAQUE plan.
 *
 * Ce que ces tests verrouillent :
 *   - 1, 2, 3 sur un plan ; un autre plan repart à 1 ;
 *   - le calcul voit les lignes supprimées (SQL brut, comme l'index) : un
 *     numéro n'est jamais réattribué ;
 *   - le serveur attribue le numéro, jamais le client ;
 *   - deux créations simultanées sur le même plan sont sérialisées par un
 *     verrou consultatif porté par la transaction, et une collision résiduelle
 *     est rejouée ;
 *   - une modification ne touche pas au numéro, sauf un changement de plan ;
 *   - une réserve sans plan n'a pas de numéro de plan.
 *
 * La base est simulée : `sequelize.query` répond au verrou et au MAX, et les
 * modèles enregistrent ce qu'on leur donne. Ce qui est testé est la LOGIQUE
 * du service, pas Postgres — l'index partiel, lui, est posé par la migration
 * `20260918000001-reserve-numero-plan.js`.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Plan: { findByPk: jest.fn(), findOne: jest.fn() },
  Reserve: { create: jest.fn(), bulkCreate: jest.fn(), findByPk: jest.fn() },
  ReservePosition: { create: jest.fn(), bulkCreate: jest.fn(), findOne: jest.fn(), findOrCreate: jest.fn() },
  ReserveHistorique: { create: jest.fn(), bulkCreate: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Media: {},
  Organisation: { findByPk: jest.fn() },
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

jest.mock('../utils/logger.js', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { UniqueConstraintError } = require('sequelize');
const sequelize = require('../config/db.js');
const { Reserve, ReservePosition, ReserveHistorique } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

const CHANTIER = '11111111-1111-4111-8111-111111111111';
const PLAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTEUR = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

/**
 * Base simulée : ce que Postgres répondrait aux deux requêtes brutes du
 * service. `numerosPlan` = MAX(numero_plan) par plan, lignes supprimées
 * comprises ; `numerosChantier` = MAX du numéro R-xxxx par chantier.
 */
function simulerBase({ numerosPlan = {}, numerosChantier = {} } = {}) {
  const verrous = [];
  sequelize.query.mockImplementation(async (sql, { replacements }) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      verrous.push(replacements.cle);
      return [{ verrou: true }];
    }
    if (sql.includes('FROM reserves WHERE plan_id')) {
      return [{ max: numerosPlan[replacements.planId] ?? 0 }];
    }
    if (sql.includes('FROM reserves')) {
      return [{ max: numerosChantier[replacements.chantierId] ?? 0 }];
    }
    throw new Error(`Requête inattendue : ${sql}`);
  });
  return { verrous };
}

function transactionFactice() {
  return { commit: jest.fn(), rollback: jest.fn(), LOCK: { UPDATE: 'UPDATE' } };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation(async () => transactionFactice());
  Reserve.create.mockImplementation(async (valeurs) => ({ id: 'nouvelle', ...valeurs }));
  Reserve.bulkCreate.mockImplementation(async (lignes) => lignes.map((v, i) => ({ id: `s${i}`, ...v })));
  ReservePosition.create.mockResolvedValue({});
  ReservePosition.bulkCreate.mockResolvedValue([]);
  ReserveHistorique.create.mockResolvedValue({});
  ReserveHistorique.bulkCreate.mockResolvedValue([]);
});

describe('_prochainsNumerosPlan — le calcul', () => {
  it('numérote 1, 2, 3 sur un plan vide puis rempli', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 0 } });
    expect(await ReserveService._prochainNumeroPlan(PLAN_A, {})).toBe(1);

    simulerBase({ numerosPlan: { [PLAN_A]: 2 } });
    expect(await ReserveService._prochainNumeroPlan(PLAN_A, {})).toBe(3);
  });

  it('repart à 1 sur un autre plan, quel que soit le remplissage du premier', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 4, [PLAN_B]: 0 } });
    expect(await ReserveService._prochainNumeroPlan(PLAN_B, {})).toBe(1);
    // Et le plan A, lui, continue à 5.
    expect(await ReserveService._prochainNumeroPlan(PLAN_A, {})).toBe(5);
  });

  it('deux plans différents peuvent porter le même numéro', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 2, [PLAN_B]: 2 } });
    expect(await ReserveService._prochainNumeroPlan(PLAN_A, {})).toBe(3);
    expect(await ReserveService._prochainNumeroPlan(PLAN_B, {})).toBe(3);
  });

  it('réserve des numéros CONSÉCUTIFS pour une série', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 3 } });
    expect(await ReserveService._prochainsNumerosPlan(PLAN_A, 3, {})).toEqual([4, 5, 6]);
  });

  it("ne rend rien sans plan — pas de numéro de plan pour une réserve hors plan", async () => {
    simulerBase();
    expect(await ReserveService._prochainsNumerosPlan(null, 2, {})).toEqual([]);
    expect(await ReserveService._prochainNumeroPlan(undefined, {})).toBeNull();
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  it('prend un verrou consultatif PROPRE AU PLAN avant de lire le MAX', async () => {
    // C'est ce verrou qui sérialise deux créations simultanées sur le même
    // plan : la seconde attend le COMMIT de la première et lit un MAX à jour.
    // Un verrou par plan, pas un verrou global : le plan B n'attend pas le A.
    const { verrous } = simulerBase({ numerosPlan: { [PLAN_A]: 0 } });
    await ReserveService._prochainNumeroPlan(PLAN_A, {});

    expect(verrous).toEqual([`reserve:numeroPlan:${PLAN_A}`]);
    const ordre = sequelize.query.mock.calls.map(([sql]) => (sql.includes('advisory') ? 'verrou' : 'max'));
    expect(ordre).toEqual(['verrou', 'max']);
  });

  it('lit le MAX en SQL brut — il voit donc les réserves supprimées', async () => {
    // L'index unique inclut les lignes soft-deleted. Si la n°4 (la plus haute)
    // est supprimée, un calcul via Sequelize (scope paranoid) retomberait sur
    // 4 → violation d'unicité définitive. Le SQL brut répond 4 → suivante 5.
    simulerBase({ numerosPlan: { [PLAN_A]: 4 } });
    expect(await ReserveService._prochainNumeroPlan(PLAN_A, {})).toBe(5);

    const [sqlMax] = sequelize.query.mock.calls.find(([sql]) => sql.includes('MAX'));
    expect(sqlMax).not.toMatch(/deleted_at/i);
  });
});

describe('la création attribue le numéro de plan', () => {
  it('la première réserve d’un plan reçoit 1, la suivante 2', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 0 }, numerosChantier: { [CHANTIER]: 0 } });
    await ReserveService._creerDansTransaction(
      { chantierId: CHANTIER, planId: PLAN_A, titre: 'Fissure', position: { x: 10, y: 20 } },
      AUTEUR
    );
    expect(Reserve.create.mock.calls[0][0]).toMatchObject({ numero: 'R-0001', numeroPlan: 1, planId: PLAN_A });

    simulerBase({ numerosPlan: { [PLAN_A]: 1 }, numerosChantier: { [CHANTIER]: 1 } });
    await ReserveService._creerDansTransaction({ chantierId: CHANTIER, planId: PLAN_A, titre: 'Tache' }, AUTEUR);
    expect(Reserve.create.mock.calls[1][0]).toMatchObject({ numero: 'R-0002', numeroPlan: 2 });
  });

  it('un nouveau plan du MÊME chantier repart à 1 alors que R-xxxx continue', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 4, [PLAN_B]: 0 }, numerosChantier: { [CHANTIER]: 4 } });
    await ReserveService._creerDansTransaction({ chantierId: CHANTIER, planId: PLAN_B, titre: 'Joint' }, AUTEUR);

    expect(Reserve.create.mock.calls[0][0]).toMatchObject({ numero: 'R-0005', numeroPlan: 1, planId: PLAN_B });
  });

  it("ignore tout numéro envoyé par le client — c'est le serveur qui numérote", async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 2 } });
    await ReserveService._creerDansTransaction(
      { chantierId: CHANTIER, planId: PLAN_A, titre: 'Fissure', numeroPlan: 99, numero: 'R-9999' },
      AUTEUR
    );
    expect(Reserve.create.mock.calls[0][0]).toMatchObject({ numeroPlan: 3, numero: 'R-0001' });
  });

  it('une réserve SANS plan n’a pas de numéro de plan', async () => {
    simulerBase();
    await ReserveService._creerDansTransaction({ chantierId: CHANTIER, titre: 'Hors plan' }, AUTEUR);

    expect(Reserve.create.mock.calls[0][0]).toMatchObject({ numeroPlan: null, planId: null });
    expect(sequelize.query.mock.calls.some(([sql]) => sql.includes('plan_id'))).toBe(false);
  });

  it('après une suppression, la suivante prend le numéro d’après — jamais un trou', async () => {
    // Plan : 1, 2, 3, 4 ; la 2 est supprimée. Le MAX reste 4 (SQL brut) :
    // la prochaine est 5, et « la 2 » ne renaît pas sous une autre réserve.
    simulerBase({ numerosPlan: { [PLAN_A]: 4 } });
    await ReserveService._creerDansTransaction({ chantierId: CHANTIER, planId: PLAN_A, titre: 'Après' }, AUTEUR);
    expect(Reserve.create.mock.calls[0][0].numeroPlan).toBe(5);
  });

  it('rejoue la création si le numéro a été pris entre-temps (collision d’unicité)', async () => {
    // Filet anti-course : une écriture qui n'aurait pas pris le verrou
    // (ancien process en cours de déploiement) heurte l'index partiel
    // `reserves_plan_numero_plan_unique` → on recalcule et on réessaie.
    simulerBase({ numerosPlan: { [PLAN_A]: 3 } });
    const collision = new UniqueConstraintError({
      message: 'duplicate key value violates unique constraint',
      errors: [],
      fields: { plan_id: PLAN_A, numero_plan: 4 },
      parent: { constraint: 'reserves_plan_numero_plan_unique' },
    });
    Reserve.create
      .mockRejectedValueOnce(collision)
      .mockImplementationOnce(async (v) => ({ id: 'nouvelle', ...v }));

    const creee = await ReserveService._creerDansTransaction(
      { chantierId: CHANTIER, planId: PLAN_A, titre: 'Course' }, AUTEUR
    );

    expect(Reserve.create).toHaveBeenCalledTimes(2);
    expect(creee.numeroPlan).toBe(4);
    // La première transaction a bien été annulée, la seconde validée.
    const transactions = await Promise.all(sequelize.transaction.mock.results.map((r) => r.value));
    expect(transactions[0].rollback).toHaveBeenCalled();
    expect(transactions[1].commit).toHaveBeenCalled();
  });

  it('une série reçoit des numéros de plan consécutifs et distincts', async () => {
    simulerBase({ numerosPlan: { [PLAN_A]: 2 }, numerosChantier: { [CHANTIER]: 10 } });
    Reserve.bulkCreate.mockImplementation(async (lignes) => lignes.map((v, i) => ({ id: `s${i}`, ...v })));

    // Par le service public : chantier, plan et phase sont simulés.
    const { Chantier, Plan, Phase } = require('../models/index.js');
    Chantier.findOne.mockResolvedValue({ id: CHANTIER, organisationId: 'org', nom: 'Océania', statut: 'en_cours' });
    Plan.findOne.mockResolvedValue({ id: PLAN_A, chantierId: CHANTIER });
    Plan.findByPk.mockResolvedValue({ id: PLAN_A, batimentId: null, etageId: null, zoneId: null });
    Phase.findOne = jest.fn().mockResolvedValue({ id: 'phase' });

    const resultat = await ReserveService.creerReserveSerie(
      'org',
      { chantierId: CHANTIER, planId: PLAN_A, titres: ['A', 'B', 'C'], phaseId: 'phase' },
      AUTEUR
    );

    expect(resultat.success).toBe(true);
    const lignes = Reserve.bulkCreate.mock.calls[0][0];
    expect(lignes.map((l) => l.numeroPlan)).toEqual([3, 4, 5]);
    expect(new Set(lignes.map((l) => l.numeroPlan)).size).toBe(3);
  });
});

describe('la modification', () => {
  /** Réserve en base, sur le plan A, numéro 3. */
  function reserveEnBase(surcharges = {}) {
    const r = {
      id: 'r3', numero: 'R-0003', numeroPlan: 3, chantierId: CHANTIER, planId: PLAN_A,
      titre: 'Fissure', statut: 'creee', severite: 'moyenne', priorite: 'moyenne',
      categorie: 'autre', chantier: { organisationId: 'org' },
      update: jest.fn(async function (valeurs) { Object.assign(this, valeurs); return this; }),
      ...surcharges,
    };
    Reserve.findByPk.mockResolvedValue(r);
    return r;
  }

  beforeEach(() => {
    const { Plan } = require('../models/index.js');
    Plan.findOne.mockImplementation(async ({ where }) => ({ id: where.id, chantierId: CHANTIER }));
    ReservePosition.findOrCreate.mockResolvedValue([{ update: jest.fn() }]);
    jest.spyOn(ReserveService, '_reponseEcriture').mockImplementation(async (r) => r);
    jest.spyOn(ReserveService, '_verifierReferences').mockResolvedValue(null);
  });

  it('ne touche pas au numéro quand seul le contenu change', async () => {
    const r = reserveEnBase();
    simulerBase({ numerosPlan: { [PLAN_A]: 7 } });

    const res = await ReserveService.modifierReserve('org', 'r3', { titre: 'Fissure élargie', description: 'x' }, AUTEUR);

    expect(res.success).toBe(true);
    expect(r.update.mock.calls[0][0]).not.toHaveProperty('numeroPlan');
    expect(r.numeroPlan).toBe(3);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  it('ne touche pas au numéro quand la position bouge sur le MÊME plan', async () => {
    const r = reserveEnBase();
    simulerBase({ numerosPlan: { [PLAN_A]: 7 } });

    await ReserveService.modifierReserve('org', 'r3', { planId: PLAN_A, position: { x: 40, y: 60 } }, AUTEUR);

    expect(r.update.mock.calls[0][0]).not.toHaveProperty('numeroPlan');
    expect(r.numeroPlan).toBe(3);
  });

  it('attribue le numéro suivant du plan d’ARRIVÉE quand la réserve change de plan', async () => {
    const r = reserveEnBase();
    simulerBase({ numerosPlan: { [PLAN_A]: 7, [PLAN_B]: 1 } });

    await ReserveService.modifierReserve('org', 'r3', { planId: PLAN_B }, AUTEUR);

    expect(r.update.mock.calls[0][0]).toMatchObject({ planId: PLAN_B, numeroPlan: 2 });
    // Le verrou pris est celui du plan d'arrivée.
    expect(sequelize.query.mock.calls[0][1].replacements.cle).toBe(`reserve:numeroPlan:${PLAN_B}`);
  });

  it('efface le numéro quand la réserve est retirée de tout plan', async () => {
    const r = reserveEnBase();
    simulerBase();

    await ReserveService.modifierReserve('org', 'r3', { planId: null }, AUTEUR);

    expect(r.update.mock.calls[0][0]).toMatchObject({ planId: null, numeroPlan: null });
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('le changement de statut', () => {
  it('laisse le numéro de plan intact', async () => {
    // « 📍 3 — À surveiller » puis « 📍 3 — Traitée » : toujours la 3.
    const r = {
      id: 'r3', numero: 'R-0003', numeroPlan: 3, chantierId: CHANTIER, planId: PLAN_A,
      statut: 'creee', chantier: { organisationId: 'org' },
      update: jest.fn(async function (v) { Object.assign(this, v); return this; }),
    };
    Reserve.findByPk.mockResolvedValue(r);
    jest.spyOn(ReserveService, '_reponseEcriture').mockImplementation(async (x) => x);

    const res = await ReserveService.changerStatut('org', 'r3', 'a_surveiller', {}, AUTEUR, 'chef_projet');

    expect(res.success).toBe(true);
    expect(r.update.mock.calls[0][0]).not.toHaveProperty('numeroPlan');
    expect(r.numeroPlan).toBe(3);
  });
});
