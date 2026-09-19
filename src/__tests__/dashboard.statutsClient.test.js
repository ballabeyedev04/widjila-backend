'use strict';

/**
 * Tests — statistiques du tableau de bord avec les statuts du client.
 *
 * Le tableau de bord mobile bâtit ses cartes, son donut et ses légendes sur
 * `stats.parStatut` ; la courbe d'évolution sur `/dashboard/evolution`. Ces
 * chiffres doivent :
 *   - couvrir TOUS les statuts du catalogue, à zéro compris — une clé absente
 *     devenait « statut inconnu » côté client ;
 *   - compter `levee` parmi les « validées » (levées) et hors des ouvertes ;
 *   - laisser `traitee` parmi les ouvertes (elle attend le contrôle) ;
 *   - tirer « traitées » et « levées » de l'HISTORIQUE, filtré sur la réserve
 *     jointe, avec un point par mois écoulé.
 *
 * `statsChantier` est calculé sans cache ; il suffit pour éprouver
 * `_agregerReserves`, commun à `statsGlobales`.
 */

jest.mock('../models/index.js', () => ({
  Chantier: { findAll: jest.fn(), findOne: jest.fn(), count: jest.fn() },
  Reserve: { findAll: jest.fn(), count: jest.fn() },
  ReserveHistorique: { findAll: jest.fn() },
  Plan: { count: jest.fn() },
  Inspection: { count: jest.fn() },
  Document: { count: jest.fn() },
  Batiment: { findAll: jest.fn(), count: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Organisation: {},
  Partenaire: { findAll: jest.fn() },
  Etage: { findAll: jest.fn() },
}));

jest.mock('../utils/cache.js', () => ({
  lire: jest.fn(),
  ecrire: jest.fn(),
  invalider: jest.fn(),
  volUnique: jest.fn((cle, calcul) => calcul()),
}));

const { Op } = require('sequelize');
const { Chantier, Reserve, ReserveHistorique, Batiment, Plan, Inspection, Document } = require('../models/index.js');
const DashboardService = require('../modules/dashboard/service/dashboard.service.js');
const { STATUT_RESERVE } = require('../config/enums.js');

const CHANTIER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  Chantier.findOne.mockResolvedValue({ id: CHANTIER, nom: 'A' });
  Batiment.count.mockResolvedValue(0);
  Plan.count.mockResolvedValue(0);
  Inspection.count.mockResolvedValue(0);
  Document.count.mockResolvedValue(0);
});

/** Une ligne de `_compterReserves` : n réserves d'un statut, dont `echues`. */
const ligne = (statut, n, echues = 0) => ({ statut, severite: 'moyenne', n: String(n), echues: String(echues) });

describe('statsChantier — répartition par statut', () => {
  it('sert chaque statut du catalogue, à zéro quand aucune réserve ne le porte', async () => {
    Reserve.findAll.mockResolvedValue([ligne('a_surveiller', 2)]);

    const { stats } = await DashboardService.statsChantier('org-1', CHANTIER);

    expect(Object.keys(stats.parStatut)).toEqual(STATUT_RESERVE);
    expect(stats.parStatut.a_surveiller).toBe(2);
    expect(stats.parStatut.levee).toBe(0);
    expect(stats.parStatut.traitee).toBe(0);
  });

  it('« levée » compte parmi les validées et sort des ouvertes ; « traitée » reste ouverte', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne('creee', 3),
      ligne('traitee', 2),
      ligne('validee', 1),
      ligne('levee', 4),
      ligne('cloturee', 1),
    ]);

    const { stats } = await DashboardService.statsChantier('org-1', CHANTIER);

    expect(stats.reserves).toEqual({ total: 11, ouvertes: 5, validees: 5, enRetard: 0 });
  });

  it('une réserve levée ne compte plus comme en retard, même échue', async () => {
    Reserve.findAll.mockResolvedValue([
      ligne('a_echeance', 2, 2),
      ligne('levee', 1, 1),
    ]);

    const { stats } = await DashboardService.statsChantier('org-1', CHANTIER);

    expect(stats.reserves.enRetard).toBe(2);
  });

  it('sans aucune réserve, la répartition reste complète (que des zéros)', async () => {
    Reserve.findAll.mockResolvedValue([]);

    const { stats } = await DashboardService.statsChantier('org-1', CHANTIER);

    expect(Object.keys(stats.parStatut)).toEqual(STATUT_RESERVE);
    expect(Object.values(stats.parStatut).every((n) => n === 0)).toBe(true);
  });
});

describe('statsGlobales — organisation sans chantier', () => {
  it('sert quand même la répartition complète par statut', async () => {
    const cache = require('../utils/cache.js');
    cache.lire.mockResolvedValue(null);
    const { Utilisateur } = require('../models/index.js');
    Utilisateur.count.mockResolvedValue(1);
    Chantier.findAll.mockResolvedValue([]);

    const { stats } = await DashboardService.statsGlobales('org-1', { auteur: { id: 'u', role: 'ChefProjet' } });

    expect(Object.keys(stats.parStatut)).toEqual(STATUT_RESERVE);
  });
});

describe('statsParEntreprise / statsParBatiment — même définition des levées', () => {
  it('par entreprise : levee est validée et fermée', async () => {
    Chantier.findAll.mockResolvedValue([{ id: CHANTIER }]);
    Reserve.findAll.mockResolvedValue([
      { statut: 'levee', entrepriseId: 'e1', entreprise: { nom: 'E1' } },
      { statut: 'traitee', entrepriseId: 'e1', entreprise: { nom: 'E1' } },
    ]);

    const { stats } = await DashboardService.statsParEntreprise('org-1');

    expect(stats[0]).toMatchObject({ total: 2, validees: 1, ouvertes: 1 });
  });

  it('par bâtiment : idem', async () => {
    Batiment.findAll.mockResolvedValue([
      { id: 'b1', nom: 'B1', reserves: [{ statut: 'levee', severite: 'haute' }, { statut: 'a_surveiller', severite: 'haute' }] },
    ]);

    const { stats } = await DashboardService.statsParBatiment('org-1', CHANTIER);

    expect(stats[0]).toMatchObject({ reserves: 2, ouvertes: 1, validees: 1 });
  });
});

describe('productivite — taux de traitement', () => {
  it('compte validee ET levee comme traitées', async () => {
    Chantier.findAll.mockResolvedValue([{ id: CHANTIER }]);
    Reserve.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    Reserve.findAll.mockResolvedValue([]);

    const { stats } = await DashboardService.productivite('org-1');

    expect(Reserve.count.mock.calls[1][0].where.statut).toEqual({ [Op.in]: ['validee', 'levee'] });
    expect(stats.tauxTraitement).toBe(40);
  });
});

describe('evolution — créées / traitées / levées par mois', () => {
  const moisCourant = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };

  beforeEach(() => {
    Chantier.findAll.mockResolvedValue([{ id: CHANTIER }]);
    Reserve.count.mockResolvedValue(0);
  });

  it('lit traitées et levées dans l’historique, filtré sur la réserve jointe', async () => {
    Reserve.findAll.mockResolvedValue([{ mois: moisCourant(), n: '5' }]);
    ReserveHistorique.findAll
      .mockResolvedValueOnce([{ mois: moisCourant(), n: '3' }]) // traitées
      .mockResolvedValueOnce([{ mois: moisCourant(), n: '2' }]); // levées

    const { stats } = await DashboardService.evolution('org-1');

    expect(stats.granularite).toBe('mois');
    const point = stats.series.find((p) => p.mois === moisCourant());
    expect(point).toEqual({ mois: moisCourant(), creees: 5, traitees: 3, levees: 2, validees: 2 });

    // Les deux requêtes d'historique portent le filtre chantier sur la
    // réserve jointe, et l'action attendue.
    const [traitees, levees] = ReserveHistorique.findAll.mock.calls.map(([opts]) => opts);
    expect(traitees.where.action).toBe('statut');
    expect(levees.where.action).toBe('validation');
    for (const opts of [traitees, levees]) {
      expect(opts.include[0]).toMatchObject({ as: 'reserve', required: true, where: { chantierId: [CHANTIER] } });
    }
  });

  it('sert un point par mois écoulé depuis janvier, à zéro par défaut', async () => {
    Reserve.findAll.mockResolvedValue([]);
    ReserveHistorique.findAll.mockResolvedValue([]);

    const { stats } = await DashboardService.evolution('org-1');

    expect(stats.series).toHaveLength(new Date().getMonth() + 1);
    expect(stats.series[0]).toEqual({ mois: `${new Date().getFullYear()}-01`, creees: 0, traitees: 0, levees: 0, validees: 0 });
    // Ordre chronologique.
    const mois = stats.series.map((p) => p.mois);
    expect([...mois].sort()).toEqual(mois);
  });

  it('sans chantier visible : séries vides, pas d’erreur', async () => {
    Chantier.findAll.mockResolvedValue([]);

    const r = await DashboardService.evolution('org-1');

    expect(r).toEqual({ success: true, stats: { series: [], comparaison: {} } });
    expect(ReserveHistorique.findAll).not.toHaveBeenCalled();
  });
});
