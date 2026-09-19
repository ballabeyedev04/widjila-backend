'use strict';

/**
 * Tests — historique des changements d'une réserve
 * (`GET /reserves/:id/historique` → `ReserveService.listHistorique`).
 *
 * Ce que l'on vérifie :
 *   - un changement de statut ÉCRIT une ligne d'historique dans la même
 *     transaction (ancien statut, nouveau statut, auteur) — et un rejeu
 *     « même statut » n'en écrit aucune ;
 *   - la réponse est NORMALISÉE : ancien/nouveau statut, nom complet de
 *     l'auteur, date serveur, du plus récent au plus ancien ;
 *   - la création est le premier changement (statut initial, sans ancien) ;
 *   - un passage automatique en retard (job, auteur `null`) est un changement ;
 *   - une ligne qui n'est pas un changement de statut (commentaire,
 *     modification) reste servie mais n'est pas signalée comme tel ;
 *   - le cloisonnement d'organisation s'applique.
 *
 * Même isolation que reserve.statutsClient.test.js.
 */

jest.mock('../models/index.js', () => ({
  Reserve: { findByPk: jest.fn() },
  ReservePosition: {},
  ReserveHistorique: { create: jest.fn().mockResolvedValue({}), findAll: jest.fn() },
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
jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

const { Reserve, ReserveHistorique } = require('../models/index.js');
const sequelize = require('../config/db.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

const fakeTransaction = () => ({
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
});

const ligne = (surcharges = {}) => ({
  id: 'h1',
  action: 'statut',
  createdAt: new Date('2026-09-18T14:32:00.000Z'),
  anciennes_valeurs: { statut: 'creee' },
  nouvelles_valeurs: { statut: 'a_surveiller' },
  utilisateur: { id: 'u1', nom: 'BEYE', prenom: 'Balla' },
  ...surcharges,
});

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockResolvedValue(fakeTransaction());
  ReserveHistorique.create.mockResolvedValue({});
});

describe('changerStatut — la trace est écrite avec le changement', () => {
  const reserve = (statut) => ({
    id: 'reserve-1', numero: 'R-0001', titre: 'Fissure', statut, assigneA: null, creePar: 'u-autre',
    update: jest.fn().mockResolvedValue(undefined),
  });

  it('écrit ancien statut, nouveau statut et auteur, dans la transaction', async () => {
    Reserve.findByPk.mockResolvedValue(reserve('creee'));

    const r = await ReserveService.changerStatut('org-1', 'reserve-1', 'a_surveiller', {}, 'u1', 'ChefProjet');

    expect(r.success).toBe(true);
    expect(ReserveHistorique.create).toHaveBeenCalledTimes(1);
    const [entree, options] = ReserveHistorique.create.mock.calls[0];
    expect(entree).toEqual({
      reserveId: 'reserve-1',
      utilisateurId: 'u1',
      action: 'statut',
      anciennes_valeurs: { statut: 'creee' },
      nouvelles_valeurs: { statut: 'a_surveiller' },
    });
    expect(options.transaction).toBeDefined();
  });

  it('un refus garde son motif dans la trace', async () => {
    Reserve.findByPk.mockResolvedValue(reserve('traitee'));

    await ReserveService.changerStatut('org-1', 'reserve-1', 'refusee', { motif: 'Joint non conforme' }, 'u1', 'ChefProjet');

    expect(ReserveHistorique.create.mock.calls[0][0]).toMatchObject({
      action: 'refus',
      nouvelles_valeurs: { statut: 'refusee', motif: 'Joint non conforme' },
    });
  });

  it('« même statut → même statut » : aucune trace, aucune écriture', async () => {
    const r = reserve('a_surveiller');
    Reserve.findByPk.mockResolvedValue(r);

    const res = await ReserveService.changerStatut('org-1', 'reserve-1', 'a_surveiller', {}, 'u1', 'ChefProjet');

    expect(res).toMatchObject({ success: true, rejeu: true });
    expect(ReserveHistorique.create).not.toHaveBeenCalled();
    expect(r.update).not.toHaveBeenCalled();
  });

  it('un changement refusé (rôle) n’écrit rien', async () => {
    Reserve.findByPk.mockResolvedValue(reserve('traitee'));

    const res = await ReserveService.changerStatut('org-1', 'reserve-1', 'levee', {}, 'u1', 'Pilote');

    expect(res.success).toBe(false);
    expect(ReserveHistorique.create).not.toHaveBeenCalled();
  });

  it('réserve inexistante : introuvable, rien d’écrit', async () => {
    Reserve.findByPk.mockResolvedValue(null);

    const res = await ReserveService.changerStatut('org-1', 'absente', 'a_surveiller', {}, 'u1', 'ChefProjet');

    expect(res).toMatchObject({ success: false, message: expect.stringMatching(/introuvable/i) });
    expect(ReserveHistorique.create).not.toHaveBeenCalled();
  });
});

describe('listHistorique — réponse normalisée', () => {
  beforeEach(() => {
    Reserve.findByPk.mockResolvedValue({ id: 'reserve-1' });
  });

  it('cloisonne sur l’organisation de la réserve', async () => {
    Reserve.findByPk.mockResolvedValue(null);

    const r = await ReserveService.listHistorique('org-2', 'reserve-1');

    expect(r.success).toBe(false);
    expect(ReserveHistorique.findAll).not.toHaveBeenCalled();
  });

  it('demande les lignes du plus récent au plus ancien, avec leur auteur', async () => {
    ReserveHistorique.findAll.mockResolvedValue([]);

    await ReserveService.listHistorique('org-1', 'reserve-1');

    const [opts] = ReserveHistorique.findAll.mock.calls[0];
    expect(opts.where).toEqual({ reserveId: 'reserve-1' });
    expect(opts.order[0]).toEqual(['createdAt', 'DESC']);
    expect(opts.include[0]).toMatchObject({ as: 'utilisateur', attributes: ['id', 'nom', 'prenom'], required: false });
  });

  it('sert ancien statut, nouveau statut, date serveur et NOM COMPLET', async () => {
    ReserveHistorique.findAll.mockResolvedValue([ligne()]);

    const { historique } = await ReserveService.listHistorique('org-1', 'reserve-1');

    expect(historique).toEqual([{
      id: 'h1',
      action: 'statut',
      date: new Date('2026-09-18T14:32:00.000Z'),
      utilisateur: { id: 'u1', nom: 'BEYE', prenom: 'Balla', nomComplet: 'Balla BEYE' },
      changementStatut: true,
      ancienStatut: 'creee',
      nouveauStatut: 'a_surveiller',
      motif: null,
    }]);
  });

  it('la création est un changement : statut initial, sans ancien', async () => {
    ReserveHistorique.findAll.mockResolvedValue([
      ligne({ id: 'h0', action: 'creation', anciennes_valeurs: null, nouvelles_valeurs: { titre: 'Fissure', statut: 'creee' } }),
    ]);

    const { historique } = await ReserveService.listHistorique('org-1', 'reserve-1');

    expect(historique[0]).toMatchObject({ changementStatut: true, ancienStatut: null, nouveauStatut: 'creee' });
  });

  it('un passage automatique en retard (job) est un changement sans auteur', async () => {
    ReserveHistorique.findAll.mockResolvedValue([
      ligne({ utilisateur: null, nouvelles_valeurs: { statut: 'en_retard', motif: 'échéance dépassée (avant le 2026-09-17)' } }),
    ]);

    const { historique } = await ReserveService.listHistorique('org-1', 'reserve-1');

    expect(historique[0]).toMatchObject({
      changementStatut: true,
      ancienStatut: 'creee',
      nouveauStatut: 'en_retard',
      utilisateur: null,
      motif: 'échéance dépassée (avant le 2026-09-17)',
    });
  });

  it('une ligne sans changement de statut (commentaire, modification) n’en est pas un', async () => {
    ReserveHistorique.findAll.mockResolvedValue([
      ligne({ id: 'h2', action: 'commentaire', anciennes_valeurs: null, nouvelles_valeurs: { message: 'ok' } }),
      ligne({ id: 'h3', action: 'modification', anciennes_valeurs: { titre: 'a' }, nouvelles_valeurs: { titre: 'b' } }),
      // Statut identique de part et d'autre : pas un changement.
      ligne({ id: 'h4', action: 'modification', anciennes_valeurs: { statut: 'creee' }, nouvelles_valeurs: { statut: 'creee' } }),
    ]);

    const { historique } = await ReserveService.listHistorique('org-1', 'reserve-1');

    expect(historique).toHaveLength(3);
    for (const h of historique) {
      expect(h).toMatchObject({ changementStatut: false, ancienStatut: null, nouveauStatut: null });
    }
  });

  it('un auteur sans prénom, ou sans nom, garde un nom complet lisible', async () => {
    ReserveHistorique.findAll.mockResolvedValue([
      ligne({ id: 'h5', utilisateur: { id: 'u2', nom: 'NDIAYE', prenom: null } }),
      ligne({ id: 'h6', utilisateur: { id: 'u3', nom: '', prenom: 'Marie' } }),
    ]);

    const { historique } = await ReserveService.listHistorique('org-1', 'reserve-1');

    expect(historique[0].utilisateur.nomComplet).toBe('NDIAYE');
    expect(historique[1].utilisateur.nomComplet).toBe('Marie');
  });
});
