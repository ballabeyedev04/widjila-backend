'use strict';

/**
 * Deuxième audit synchronisation — écritures de réserve sous concurrence et
 * rejeu.
 *
 *  - A2-03 : création, statut et modification répondaient la ligne BRUTE, sans
 *    ses associations (plan, phase, corps d'état, lot, créateur…). Le mobile
 *    l'écrivait telle quelle dans son cache : hors ligne, la réserve perdait
 *    plan, phase et localisation jusqu'au tirage suivant.
 *  - A2-06 : deux changements de statut simultanés étaient validés contre le
 *    MÊME état lu au départ. Une réserve pouvait passer « validée » puis « en
 *    cours » — transition interdite — et le verdict disparaissait.
 *  - A2-12 : supprimer une réserve déjà supprimée (rejeu d'une suppression
 *    dont la réponse s'est perdue) répondait « introuvable » : faux échec.
 *  - A2-13 : deux personnes modifiant le MÊME champ : la seconde écrasait la
 *    première sans que personne le sache.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Reserve: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  ReservePosition: { create: jest.fn(), findOrCreate: jest.fn() },
  ReserveHistorique: { create: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Commentaire: { destroy: jest.fn() },
  Media: { count: jest.fn() },
  CorpsEtat: {},
  Phase: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Plan: {},
  Organisation: {},
  Utilisateur: {},
  PieceJointe: { destroy: jest.fn() },
  ReserveAffectation: { count: jest.fn(), destroy: jest.fn() },
  Signature: {},
  Partenaire: {},
}));

jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const sequelize = require('../config/db.js');
const modeles = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

const { Reserve, ReserveHistorique, Chantier, Media } = modeles;
const ORG = 'org-1';

function transactionFactice() {
  const liberations = [];
  return {
    LOCK: { UPDATE: 'UPDATE' },
    liberations,
    commit: jest.fn(async () => liberations.splice(0).forEach((l) => l())),
    rollback: jest.fn(async () => liberations.splice(0).forEach((l) => l())),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation(async () => transactionFactice());
  sequelize.query.mockResolvedValue([{ max: 0 }]);
  ReserveHistorique.create.mockResolvedValue({});
  Media.count.mockResolvedValue(1);
  modeles.ReserveAffectation.count.mockResolvedValue(0);
});

describe('A2-03 — les écritures répondent la réserve COMPLÈTE', () => {
  const complete = () => ({ id: 'res-1', complete: true });

  it('création : relue avec plan, phase, position, créateur…', async () => {
    Chantier.findOne.mockResolvedValue({ id: 'ch-1', organisationId: ORG, statut: 'en_cours', nom: 'C' });
    Reserve.findOne.mockResolvedValue(null);
    Reserve.create.mockImplementation(async (v) => ({ ...v, id: 'res-1' }));
    Reserve.findByPk.mockResolvedValue(complete());

    const r = await ReserveService.creerReserve(ORG, { chantierId: 'ch-1', titre: 'Fissure' }, 'u-1');

    expect(r.success).toBe(true);
    expect(r.reserve).toEqual(complete());
    const alias = Reserve.findByPk.mock.calls.at(-1)[1].include.map((i) => i.as);
    expect(alias).toEqual(expect.arrayContaining(['plan', 'phase', 'position', 'createur', 'corpsEtat', 'lot']));
  });

  it('statut : la réponse est relue après l’écriture', async () => {
    const ligne = { id: 'res-1', statut: 'creee', creePar: 'u-1', update: jest.fn(async (u) => Object.assign(ligne, u)) };
    Reserve.findByPk.mockImplementation(async (id, options = {}) => (options.include?.length > 2 ? complete() : ligne));

    const r = await ReserveService.changerStatut(ORG, 'res-1', 'affectee', {}, 'u-1', 'Admin');

    expect(r.success).toBe(true);
    expect(r.reserve).toEqual(complete());
  });
});

describe('A2-06 — deux changements de statut SIMULTANÉS', () => {
  it('le second est jugé sur l’état laissé par le premier, pas sur l’état de départ', async () => {
    // Une ligne partagée, et un vrai verrou de ligne : `lock: UPDATE` ne rend
    // la main qu'une fois la transaction qui le tient terminée.
    const enBase = { id: 'res-1', statut: 'a_verifier', creePar: 'u-0', assigneA: null };
    let verrou = Promise.resolve();
    const lire = () => ({
      ...enBase,
      update: jest.fn(async (u) => {
        await new Promise((r) => setTimeout(r, 10));
        Object.assign(enBase, u);
      }),
    });
    Reserve.findByPk.mockImplementation(async (id, options = {}) => {
      if (options.lock && options.transaction) {
        const precedent = verrou;
        let liberer;
        verrou = new Promise((r) => { liberer = r; });
        await precedent;
        options.transaction.liberations.push(liberer);
      }
      return lire();
    });

    const [a, b] = await Promise.all([
      ReserveService.changerStatut(ORG, 'res-1', 'validee', {}, 'u-1', 'Admin'),
      ReserveService.changerStatut(ORG, 'res-1', 'en_cours', {}, 'u-2', 'Admin'),
    ]);

    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    const refus = [a, b].find((x) => !x.success);
    expect(refus.message).toMatch(/Transition impossible/);
    expect(enBase.statut).toBe('validee');
  });
});

describe('A2-12 — suppression rejouée', () => {
  it('une réserve DÉJÀ supprimée dans la même organisation : succès sans effet', async () => {
    Reserve.findByPk.mockResolvedValue(null);
    Reserve.findOne.mockResolvedValue({ id: 'res-1', deletedAt: new Date(), chantier: { organisationId: ORG } });

    const r = await ReserveService.supprimerReserve(ORG, 'res-1', 'u-1');

    expect(r.success).toBe(true);
    expect(r.rejeu).toBe(true);
    expect(ReserveHistorique.create).not.toHaveBeenCalled();
  });

  it('une réserve d’une AUTRE organisation reste introuvable', async () => {
    Reserve.findByPk.mockResolvedValue(null);
    Reserve.findOne.mockResolvedValue({ id: 'res-1', deletedAt: new Date(), chantier: { organisationId: 'org-2' } });

    const r = await ReserveService.supprimerReserve(ORG, 'res-1', 'u-1');

    expect(r.success).toBe(false);
  });

  it('une réserve qui n’a jamais existé reste introuvable', async () => {
    Reserve.findByPk.mockResolvedValue(null);
    Reserve.findOne.mockResolvedValue(null);

    expect((await ReserveService.supprimerReserve(ORG, 'res-x', 'u-1')).success).toBe(false);
  });
});

describe('A2-13 — conflits de modification, champ par champ', () => {
  function ligneServeur(valeurs) {
    const ligne = {
      id: 'res-1', statut: 'affectee', chantierId: 'ch-1', ...valeurs,
      update: jest.fn(async (u) => Object.assign(ligne, u)),
    };
    return ligne;
  }

  it('même champ modifié ailleurs entre-temps : CONFLIT signalé, rien n’est écrasé', async () => {
    const ligne = ligneServeur({ titre: 'Ahmed', description: 'd' });
    Reserve.findByPk.mockResolvedValue(ligne);

    const r = await ReserveService.modifierReserve(ORG, 'res-1', {
      titre: 'Mamadou', valeursInitiales: { titre: 'Titre de départ' },
    }, 'u-2');

    expect(r.success).toBe(false);
    expect(r.code).toBe('CONFLIT_MODIFICATION');
    expect(r.conflits).toEqual([{ champ: 'titre', valeurServeur: 'Ahmed', valeurDemandee: 'Mamadou' }]);
    expect(ligne.update).not.toHaveBeenCalled();
    expect(ligne.titre).toBe('Ahmed');
  });

  it('champs DIFFÉRENTS modifiés par deux personnes : les deux modifications sont gardées', async () => {
    // A a déjà changé le titre ; B, parti du même état, change la description.
    const ligne = ligneServeur({ titre: 'Titre de A', description: 'd' });
    Reserve.findByPk.mockResolvedValue(ligne);

    const r = await ReserveService.modifierReserve(ORG, 'res-1', {
      description: 'Description de B', valeursInitiales: { description: 'd' },
    }, 'u-2');

    expect(r.success).toBe(true);
    expect(ligne.titre).toBe('Titre de A');
    expect(ligne.description).toBe('Description de B');
  });

  it('rejeu d’une modification déjà appliquée (même valeur finale) : pas de conflit', async () => {
    const ligne = ligneServeur({ titre: 'Mamadou' });
    Reserve.findByPk.mockResolvedValue(ligne);

    const r = await ReserveService.modifierReserve(ORG, 'res-1', {
      titre: 'Mamadou', valeursInitiales: { titre: 'Titre de départ' },
    }, 'u-2');

    expect(r.success).toBe(true);
  });

  it('sans valeurs initiales (ancien client, web) : comportement historique', async () => {
    const ligne = ligneServeur({ titre: 'Ahmed' });
    Reserve.findByPk.mockResolvedValue(ligne);

    const r = await ReserveService.modifierReserve(ORG, 'res-1', { titre: 'Mamadou' }, 'u-2');

    expect(r.success).toBe(true);
    expect(ligne.titre).toBe('Mamadou');
  });

  it('dates : « 2026-09-30 » et « 2026-09-30T00:00:00.000Z » sont la même valeur', async () => {
    const ligne = ligneServeur({ date_limite: '2026-09-30' });
    Reserve.findByPk.mockResolvedValue(ligne);

    const r = await ReserveService.modifierReserve(ORG, 'res-1', {
      date_limite: '2026-10-15', valeursInitiales: { date_limite: '2026-09-30T00:00:00.000Z' },
    }, 'u-2');

    expect(r.success).toBe(true);
  });
});
