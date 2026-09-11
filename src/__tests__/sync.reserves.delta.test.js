'use strict';

/**
 * Audit synchronisation — tirage INCRÉMENTAL des réserves (`GET /sync/reserves`).
 *
 * Défaut corrigé : le mobile n'apprenait jamais qu'une réserve avait été
 * supprimée sur le serveur. Elle restait dans son cache et réapparaissait
 * hors ligne. Le tirage sert désormais les changements ET les suppressions
 * depuis un curseur, page par page, dans le périmètre exact de l'appelant.
 */

jest.mock('../config/db.js', () => ({
  literal: jest.fn((val) => ({ val })),
  escape: jest.fn((v) => `'${String(v).replace(/'/g, "''")}'`),
}));

jest.mock('../models/index.js', () => ({
  Reserve: { findAll: jest.fn() },
  ReservePosition: {},
  Chantier: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  CorpsEtat: {},
  Phase: {},
  Organisation: {},
  Partenaire: {},
  Utilisateur: {},
  Media: {},
}));

jest.mock('../modules/chantier/service/chantier.service.js', () => ({
  filtreCloisonnement: jest.fn(() => null),
}));

const { Reserve } = require('../models/index.js');
const ChantierService = require('../modules/chantier/service/chantier.service.js');
const SyncService = require('../modules/sync/service/sync.service.js');
const syncController = require('../modules/sync/controller/sync.controller.js');

const ORG = 'org-1';
const AUTEUR = { id: 'u-1', role: 'ChefProjet', organisationId: ORG };

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Une ligne telle que Sequelize la rendrait (attribut calculé compris). */
function ligne(id, marque, { deletedAt = null, chantierDeletedAt = null } = {}) {
  const valeurs = {
    id, titre: `Réserve ${id.slice(0, 1)}`, deletedAt, marqueSync: marque,
    chantier: { id: 'ch-1', nom: 'Résidence', deletedAt: chantierDeletedAt },
  };
  return {
    id,
    get: (cle) => valeurs[cle],
    toJSON: () => ({ ...valeurs }),
  };
}

const optionsTirage = () => Reserve.findAll.mock.calls[0][0];
const literaux = () => optionsTirage().where[Object.getOwnPropertySymbols(optionsTirage().where)[0]]
  .map((l) => l.val);

beforeEach(() => {
  jest.clearAllMocks();
  ChantierService.filtreCloisonnement.mockReturnValue(null);
  Reserve.findAll.mockResolvedValue([]);
});

describe('premier tirage', () => {
  it('part de l’origine et sépare changements et suppressions', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne(ID_A, '2026-09-10T08:00:00.000001Z'),
      ligne(ID_B, '2026-09-10T09:00:00.000002Z', { deletedAt: '2026-09-10T09:00:00Z' }),
    ]);

    const r = await SyncService.deltaReserves(ORG, AUTEUR, {});

    expect(r.success).toBe(true);
    expect(r.modifiees.map((x) => x.id)).toEqual([ID_A]);
    expect(r.supprimees).toEqual([{ id: ID_B, supprimeeLe: '2026-09-10T09:00:00Z' }]);
    expect(r.termine).toBe(true);
    expect(literaux()[0]).toContain("'1970-01-01T00:00:00.000000Z'");
  });

  it('la marque technique ne fuit pas dans les données servies', async () => {
    Reserve.findAll.mockResolvedValue([ligne(ID_A, '2026-09-10T08:00:00.000001Z')]);

    const r = await SyncService.deltaReserves(ORG, AUTEUR, {});

    expect(r.modifiees[0]).not.toHaveProperty('marqueSync');
  });

  it('le curseur rendu désigne la DERNIÈRE ligne servie, à la microseconde', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne(ID_A, '2026-09-10T08:00:00.000001Z'),
      ligne(ID_B, '2026-09-10T08:00:00.000999Z'),
    ]);

    const r = await SyncService.deltaReserves(ORG, AUTEUR, {});

    expect(SyncService._decoderCurseur(r.curseur)).toEqual({ m: '2026-09-10T08:00:00.000999Z', i: ID_B });
  });
});

describe('pagination et reprise', () => {
  it('une page pleine annonce qu’il reste des lignes, et n’en sert pas une de trop', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne(ID_A, '2026-09-10T08:00:00.000001Z'),
      ligne(ID_B, '2026-09-10T08:00:00.000002Z'),
      ligne(ID_C, '2026-09-10T08:00:00.000003Z'),
    ]);

    const r = await SyncService.deltaReserves(ORG, AUTEUR, { limite: 2 });

    expect(optionsTirage().limit).toBe(3);
    expect(r.modifiees.map((x) => x.id)).toEqual([ID_A, ID_B]);
    expect(r.termine).toBe(false);
    expect(SyncService._decoderCurseur(r.curseur).i).toBe(ID_B);
  });

  it('la page suivante repart STRICTEMENT après le curseur (marque, id)', async () => {
    const curseur = SyncService._encoderCurseur({ m: '2026-09-10T08:00:00.000002Z', i: ID_B });

    await SyncService.deltaReserves(ORG, AUTEUR, { curseur });

    const [apres] = literaux();
    expect(apres).toMatch(/\(GREATEST\(.*\), "Reserve"\."id"\) > \(CAST\('2026-09-10T08:00:00\.000002Z' AS timestamptz\), CAST\('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AS uuid\)\)/);
    expect(optionsTirage().order[1]).toEqual(['id', 'ASC']);
  });

  it('sans nouvelle ligne, le curseur reste celui reçu', async () => {
    const curseur = SyncService._encoderCurseur({ m: '2026-09-10T08:00:00.000002Z', i: ID_B });

    const r = await SyncService.deltaReserves(ORG, AUTEUR, { curseur });

    expect(r.modifiees).toEqual([]);
    expect(r.termine).toBe(true);
    expect(SyncService._decoderCurseur(r.curseur)).toEqual({ m: '2026-09-10T08:00:00.000002Z', i: ID_B });
  });

  it('s’arrête 5 s avant « maintenant » : une transaction en vol ne sera pas sautée', async () => {
    const avant = Date.now();
    await SyncService.deltaReserves(ORG, AUTEUR, {});

    const horizon = Date.parse(literaux()[1].match(/'([^']+)'/)[1]);
    expect(horizon).toBeLessThanOrEqual(avant - 4000);
    expect(horizon).toBeGreaterThan(avant - 7000);
  });
});

describe('curseur hostile', () => {
  it.each([
    ['du texte quelconque', 'pas-un-curseur'],
    ['une injection dans la marque', Buffer.from(JSON.stringify({ m: "2026-01-01' OR 1=1 --", i: ID_A })).toString('base64url')],
    ['un id qui n’est pas un uuid', Buffer.from(JSON.stringify({ m: '2026-09-10T08:00:00.000002Z', i: '1; DROP TABLE reserves' })).toString('base64url')],
  ])('refuse %s sans interroger la base', async (_libelle, curseur) => {
    const r = await SyncService.deltaReserves(ORG, AUTEUR, { curseur });

    expect(r.success).toBe(false);
    expect(Reserve.findAll).not.toHaveBeenCalled();
  });
});

describe('périmètre', () => {
  it('lit les supprimées, dans l’organisation de l’appelant seulement', async () => {
    await SyncService.deltaReserves(ORG, AUTEUR, {});

    const options = optionsTirage();
    expect(options.paranoid).toBe(false);
    const chantier = options.include.find((i) => i.as === 'chantier');
    expect(chantier.required).toBe(true);
    expect(chantier.paranoid).toBe(false);
    expect(chantier.where).toEqual({ organisationId: ORG });
  });

  it('applique le cloisonnement par chantier du compte', async () => {
    const regle = { demandeurId: null };
    ChantierService.filtreCloisonnement.mockReturnValue(regle);

    await SyncService.deltaReserves(ORG, { id: 'st-1', role: 'SousTraitant' }, {});

    const chantier = optionsTirage().include.find((i) => i.as === 'chantier');
    expect(chantier.where).toEqual({ organisationId: ORG, demandeurId: null });
  });

  it('une réserve d’un chantier SUPPRIMÉ est servie comme suppression', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne(ID_A, '2026-09-10T08:00:00.000001Z', { chantierDeletedAt: '2026-09-10T07:00:00Z' }),
    ]);

    const r = await SyncService.deltaReserves(ORG, AUTEUR, {});

    expect(r.modifiees).toEqual([]);
    expect(r.supprimees.map((s) => s.id)).toEqual([ID_A]);
  });
});

describe('contrôleur', () => {
  const reponse = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  it('un compte sans organisation (super-admin) est refusé en 400', async () => {
    const next = jest.fn();
    await syncController.reserves({ user: { id: 'sa', organisationId: null }, query: {} }, reponse(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(Reserve.findAll).not.toHaveBeenCalled();
  });

  it('l’organisation vient du jeton, jamais de la requête', async () => {
    const res = reponse();
    await syncController.reserves(
      { user: AUTEUR, query: { organisationId: 'org-pirate' } }, res, jest.fn(),
    );

    const chantier = optionsTirage().include.find((i) => i.as === 'chantier');
    expect(chantier.where.organisationId).toBe(ORG);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
