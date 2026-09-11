'use strict';

/**
 * Audit synchronisation — changement de statut REJOUÉ.
 *
 * ## Le défaut
 *
 * Le mobile envoie « passer en corrigée ». Le serveur l'applique, puis la
 * réponse se perd (réseau de chantier). Le mobile n'a pas d'acquittement :
 * l'action reste en file et repart au passage suivant. Le serveur voit alors
 * « corrigée → corrigée », que la matrice des transitions n'autorise pas, et
 * répond 400 « Transition impossible ».
 *
 * Le mobile classait ce 400 en refus DÉFINITIF : l'action apparaissait en
 * échec dans l'écran de synchronisation alors que le serveur avait bel et
 * bien appliqué le changement. C'est un faux échec — l'utilisateur recommence
 * un travail déjà fait, ou croit sa correction perdue.
 *
 * ## La règle
 *
 * Demander le statut DÉJÀ en place est sans effet et répond succès. Les
 * contrôles de DROITS passent d'abord : un rejeu ne doit jamais servir à
 * contourner une permission.
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
  Partenaire: { findOne: jest.fn() },
}));
jest.mock('../config/db.js', () => ({
  transaction: jest.fn(),
}));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

const { Reserve, ReserveHistorique, ReserveAffectation } = require('../models/index.js');
const sequelize = require('../config/db.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

function fakeReserve(overrides = {}) {
  return {
    id: 'reserve-1',
    statut: 'corrigee',
    assigneA: null,
    creePar: 'createur-1',
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ReserveAffectation.count.mockResolvedValue(0);
  sequelize.transaction.mockResolvedValue({
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  });
});

describe('rejeu d’un statut déjà appliqué', () => {
  it('répond SUCCÈS sans rien réécrire ni historiser', async () => {
    const reserve = fakeReserve({ statut: 'corrigee' });
    Reserve.findByPk.mockResolvedValue(reserve);

    const r = await ReserveService.changerStatut('org-1', 'reserve-1', 'corrigee', {}, 'u-1', 'Admin');

    expect(r.success).toBe(true);
    expect(r.rejeu).toBe(true);
    expect(r.reserve).toBe(reserve);
    expect(reserve.update).not.toHaveBeenCalled();
    expect(ReserveHistorique.create).not.toHaveBeenCalled();
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('ne renvoie pas une seconde notification', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'en_cours' }));

    await ReserveService.changerStatut('org-1', 'reserve-1', 'en_cours', {}, 'u-1', 'Admin');

    expect(NotificationService.notifier).not.toHaveBeenCalled();
  });

  it('un statut de CONTRÔLE rejoué par un rôle non autorisé reste refusé', async () => {
    // Le rejeu ne doit jamais devenir un moyen de faire confirmer par le
    // serveur un verdict que ce rôle n'a pas le droit de prononcer.
    // `Pilote` : intervenant de terrain, hors PILOTAGE — il déclare, il ne
    // valide pas. (`Entreprise`, titulaire du compte, fait partie du pilotage.)
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'validee' }));

    const r = await ReserveService.changerStatut('org-1', 'reserve-1', 'validee', {}, 'u-1', 'Pilote');

    expect(r.success).toBe(false);
  });

  it('un sous-traitant NON assigné reste refusé, même sur un statut identique', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'en_cours', assigneA: 'quelqu-un-d-autre' }));

    const r = await ReserveService.changerStatut('org-1', 'reserve-1', 'en_cours', {}, 'st-1', 'SousTraitant');

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/assign/i);
  });

  it('une vraie transition interdite reste refusée', async () => {
    Reserve.findByPk.mockResolvedValue(fakeReserve({ statut: 'cloturee' }));

    const r = await ReserveService.changerStatut('org-1', 'reserve-1', 'en_cours', {}, 'u-1', 'Admin');

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Transition impossible/);
  });
});
