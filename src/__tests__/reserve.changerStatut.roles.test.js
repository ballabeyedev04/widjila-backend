'use strict';

/**
 * Tests — modules/reserve/service/reserve.service.js#changerStatut, focalisés
 * sur les nouveaux rôles "Pilote" et "SousTraitant" (ajout du statut
 * "prise_en_charge" et de la garde d'assignation dédiée au sous-traitant).
 *
 * C'est le PREMIER test de ce service (aucun n'existait avant) : les modèles
 * Sequelize, la transaction et le service de notification sont mockés pour
 * isoler la LOGIQUE de permission/transition, sans base PostgreSQL réelle —
 * même approche que auth.lockout.test.js.
 */

jest.mock('../models/index.js', () => ({
  Reserve: { findByPk: jest.fn() },
  ReservePosition: {},
  ReserveHistorique: { create: jest.fn().mockResolvedValue({}) },
  Commentaire: {},
  Media: { count: jest.fn().mockResolvedValue(1) },
  Chantier: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Plan: {},
  Organisation: {},
  Utilisateur: {},
  PieceJointe: {},
  ReserveAffectation: { count: jest.fn().mockResolvedValue(0) },
  Signature: {},
}));
jest.mock('../config/db.js', () => ({
  transaction: jest.fn(),
}));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

const { Reserve, ReserveAffectation, Media } = require('../models/index.js');
const sequelize = require('../config/db.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

function fakeReserve(overrides = {}) {
  return {
    id: 'reserve-1',
    statut: 'affectee',
    assigneA: null,
    creePar: 'createur-1',
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeTransaction() {
  return { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
}

describe('ReserveService.changerStatut — rôle SousTraitant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Media.count = jest.fn().mockResolvedValue(1);
    ReserveAffectation.count = jest.fn().mockResolvedValue(0);
    sequelize.transaction.mockResolvedValue(fakeTransaction());
  });

  test('peut prendre en charge une réserve qui lui est assignée (assigneA)', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ assigneA: 'user-st-1' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'prise_en_charge', {}, 'user-st-1', 'SousTraitant'
    );

    expect(result.success).toBe(true);
  });

  test('peut agir via une affectation secondaire (ReserveAffectation), pas seulement assigneA', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ assigneA: 'quelqu-un-d-autre' }));
    ReserveAffectation.count.mockResolvedValue(1);

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'en_cours', {}, 'user-st-1', 'SousTraitant'
    );

    expect(result.success).toBe(true);
  });

  test('refuse d’agir sur une réserve qui ne lui est pas assignée', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'prise_en_charge', assigneA: 'quelqu-un-d-autre' }));
    ReserveAffectation.count.mockResolvedValue(0);

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'en_cours', {}, 'user-st-1', 'SousTraitant'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/pas assignée/i);
  });

  test('refuse un verdict (validee) même sur sa propre réserve assignée', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'corrigee', assigneA: 'user-st-1' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'validee', {}, 'user-st-1', 'SousTraitant'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/ne permet pas de valider/i);
  });

  test('refuse une ré-affectation (statut "affectee"), même assigné — distinct de la garde de verdict', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'prise_en_charge', assigneA: 'user-st-1' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'affectee', {}, 'user-st-1', 'SousTraitant'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/sous-traitant/i);
  });
});

describe('ReserveService.changerStatut — statut "prise_en_charge" dans la matrice de transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Media.count = jest.fn().mockResolvedValue(1);
    sequelize.transaction.mockResolvedValue(fakeTransaction());
  });

  test('un rôle de pilotage peut faire transiter affectee → prise_en_charge', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'affectee' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'prise_en_charge', {}, 'user-1', 'ChefProjet'
    );

    expect(result.success).toBe(true);
  });

  test('prise_en_charge → en_cours est une transition légale', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'prise_en_charge' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'en_cours', {}, 'user-1', 'ChefProjet'
    );

    expect(result.success).toBe(true);
  });

  test('une transition non prévue par la matrice reste refusée (ex: creee → prise_en_charge)', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'creee' }));

    const result = await ReserveService.changerStatut(
      'org-1', 'reserve-1', 'prise_en_charge', {}, 'user-1', 'ChefProjet'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/transition impossible/i);
  });
});

describe('config/roles.js — groupes des nouveaux rôles', () => {
  const { PILOTAGE, RESERVE_INTERVENANTS, SOUS_TRAITANT } = require('../config/roles.js');

  test('Pilote peut intervenir sur les réserves mais ne fait jamais de pilotage/validation', () => {
    expect(RESERVE_INTERVENANTS).toContain('Pilote');
    expect(PILOTAGE).not.toContain('Pilote');
  });

  test('SousTraitant n’est ni dans RESERVE_INTERVENANTS (accès route large) ni dans PILOTAGE', () => {
    expect(RESERVE_INTERVENANTS).not.toContain('SousTraitant');
    expect(PILOTAGE).not.toContain('SousTraitant');
    expect(SOUS_TRAITANT).toEqual(['SousTraitant']);
  });
});
