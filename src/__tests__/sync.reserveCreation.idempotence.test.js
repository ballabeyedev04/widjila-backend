'use strict';

/**
 * Audit synchronisation — création de réserve REJOUÉE par la file hors ligne.
 *
 * ## Les défauts
 *
 * 1. COURSE DE CRÉATION. Le mobile génère l'identifiant de la réserve et le
 *    renvoie tel quel à chaque rejeu. Le contrôle d'idempotence de
 *    `creerReserve` lit la réserve AVANT d'écrire : si deux requêtes portant
 *    le même identifiant se chevauchent (délai de réponse dépassé côté mobile
 *    pendant que le serveur écrit encore, puis rejeu immédiat), la seconde ne
 *    voit rien, tente l'insertion, et heurte la clé primaire. L'erreur
 *    remontait en 409 « Cette ressource existe déjà » ; le mobile la classait
 *    en refus DÉFINITIF et SUPPRIMAIT la réserve de son cache local — alors
 *    qu'elle existe bel et bien sur le serveur.
 *
 * 2. PAGE PERDUE. `position.page` est validée par Joi puis ignorée à
 *    l'écriture : `ReservePosition.create` ne recevait que x, y et zoom. Une
 *    réserve posée sur la page 7 d'un PDF était enregistrée sur la page 1 —
 *    au bon endroit, sur le mauvais plan. Le mobile affichait la page 7, le
 *    serveur la page 1 : local et distant divergeaient dès la création.
 */

const { UniqueConstraintError } = require('sequelize');

jest.mock('../config/db.js', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Reserve: { findOne: jest.fn(), create: jest.fn() },
  ReservePosition: { create: jest.fn() },
  ReserveHistorique: { create: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Commentaire: {},
  Media: {},
  CorpsEtat: {},
  Phase: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Plan: {},
  Organisation: {},
  Utilisateur: {},
  PieceJointe: {},
  ReserveAffectation: {},
  Signature: {},
  Partenaire: {},
}));

jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const sequelize = require('../config/db.js');
const { Reserve, ReservePosition, ReserveHistorique, Chantier } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

const ORG = 'org-1';
const AUTRE_ORG = 'org-2';
const CHANTIER = 'chantier-1';
const USER = 'user-1';
const ID = '9f0e7c2a-1b2c-4d5e-8f90-0a1b2c3d4e5f';

/** Collision sur la CLÉ PRIMAIRE, telle que PostgreSQL la signale via Sequelize. */
function collisionClePrimaire() {
  return new UniqueConstraintError({
    message: 'Validation error',
    fields: { id: ID },
    parent: { constraint: 'reserves_pkey', sql: '' },
  });
}

let transactions;

beforeEach(() => {
  jest.clearAllMocks();
  transactions = [];
  sequelize.transaction.mockImplementation(async () => {
    const t = { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
    transactions.push(t);
    return t;
  });
  // Verrou de numérotation puis lecture du MAX : la seconde requête attend un tableau.
  sequelize.query.mockResolvedValue([{ max: 3 }]);
  Chantier.findOne.mockResolvedValue({ id: CHANTIER, organisationId: ORG, statut: 'en_cours', nom: 'Résidence Horizon' });
  Reserve.findOne.mockResolvedValue(null);
  Reserve.create.mockImplementation(async (v) => ({ ...v, id: v.id || 'gen-1' }));
  ReservePosition.create.mockResolvedValue({});
  ReserveHistorique.create.mockResolvedValue({});
});

describe('position sur le plan', () => {
  it('la PAGE du document est enregistrée avec le point', async () => {
    const res = await ReserveService.creerReserve(ORG, {
      chantierId: CHANTIER,
      titre: 'Fissure',
      position: { x: 10, y: 20, zoom: 1, page: 7 },
    }, USER);

    expect(res.success).toBe(true);
    expect(ReservePosition.create).toHaveBeenCalledWith(
      expect.objectContaining({ x: 10, y: 20, page: 7 }),
      expect.anything(),
    );
  });

  it('sans page fournie, la réserve va sur la page 1', async () => {
    await ReserveService.creerReserve(ORG, {
      chantierId: CHANTIER,
      titre: 'Fissure',
      position: { x: 10, y: 20 },
    }, USER);

    expect(ReservePosition.create).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1 }),
      expect.anything(),
    );
  });
});

describe('rejeu concurrent d’une création (même identifiant client)', () => {
  it('la seconde requête répond SUCCÈS avec la réserve existante, pas 409', async () => {
    Reserve.findOne
      // Contrôle d'idempotence : la première requête n'a pas encore validé.
      .mockResolvedValueOnce(null)
      // Relecture après la collision : la réserve est là, dans la bonne organisation.
      .mockResolvedValueOnce({ id: ID, deletedAt: null, chantier: { organisationId: ORG } });
    Reserve.create.mockRejectedValueOnce(collisionClePrimaire());

    const res = await ReserveService.creerReserve(ORG, { id: ID, chantierId: CHANTIER, titre: 'Fissure' }, USER);

    expect(res.success).toBe(true);
    expect(res.rejeu).toBe(true);
    expect(res.reserve.id).toBe(ID);
    // La transaction de la tentative perdante est bien annulée.
    expect(transactions[0].rollback).toHaveBeenCalled();
  });

  it('la relecture inclut les réserves supprimées (paranoid: false)', async () => {
    Reserve.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ID, deletedAt: null, chantier: { organisationId: ORG } });
    Reserve.create.mockRejectedValueOnce(collisionClePrimaire());

    await ReserveService.creerReserve(ORG, { id: ID, chantierId: CHANTIER, titre: 'Fissure' }, USER);

    expect(Reserve.findOne.mock.calls[1][0]).toEqual(expect.objectContaining({ paranoid: false }));
  });

  it('une réserve SUPPRIMÉE entre-temps est un refus explicite, pas un succès', async () => {
    Reserve.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ID, deletedAt: new Date(), chantier: { organisationId: ORG } });
    Reserve.create.mockRejectedValueOnce(collisionClePrimaire());

    const res = await ReserveService.creerReserve(ORG, { id: ID, chantierId: CHANTIER, titre: 'Fissure' }, USER);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/supprim/i);
  });

  it('un identifiant appartenant à une AUTRE organisation n’est jamais confirmé', async () => {
    Reserve.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ID, deletedAt: null, chantier: { organisationId: AUTRE_ORG } });
    Reserve.create.mockRejectedValueOnce(collisionClePrimaire());

    const res = await ReserveService.creerReserve(ORG, { id: ID, chantierId: CHANTIER, titre: 'Fissure' }, USER);

    expect(res.success).toBe(false);
    expect(res.reserve).toBeUndefined();
  });

  it('une collision SANS identifiant client n’est pas masquée', async () => {
    // Sans `id` fourni, une violation d'unicité n'est pas un rejeu : la
    // cacher derrière un succès serait mentir sur ce qui s'est passé.
    Reserve.create.mockRejectedValueOnce(collisionClePrimaire());

    await expect(
      ReserveService.creerReserve(ORG, { chantierId: CHANTIER, titre: 'Fissure' }, USER),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});
