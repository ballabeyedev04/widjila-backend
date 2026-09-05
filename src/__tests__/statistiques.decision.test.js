'use strict';

/**
 * Tests — compteurs de DÉCISION de la vue plateforme.
 *
 * ## Ce qui manquait
 *
 * L'écran comptait ce qui EXISTE — organisations, utilisateurs, chantiers,
 * réserves — et jamais ce qui ATTEND.
 *
 * Or le super-admin ne crée rien : il tranche. Une inscription en attente,
 * une demande de chantier non examinée, un plan non vérifié, ce sont des
 * gens qui attendent une réponse à l'autre bout. Un tableau de bord qui
 * affiche le volume du parc sans montrer cette file ne décrit pas le travail
 * de celui qui le regarde.
 *
 * ## Le point de vigilance
 *
 * « Chantier actif » doit se définir EXACTEMENT comme dans la liste des
 * chantiers : ni en attente, ni rejeté. Deux définitions différentes
 * donneraient deux chiffres différents pour la même chose sur deux écrans
 * voisins — et c'est ainsi qu'un compteur passe pour une panne.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { count: jest.fn(), findAll: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
  Reserve: { count: jest.fn(), findAll: jest.fn() },
  Plan: { count: jest.fn() },
}));

const { Op } = require('sequelize');
const { Utilisateur, Chantier, Reserve, Organisation, Plan } = require('../models/index.js');
const StatistiquesService = require('../modules/admin/service/statistiques.service.js');

beforeEach(() => {
  jest.clearAllMocks();
  Organisation.findAll.mockResolvedValue([]);
  Reserve.findAll.mockResolvedValue([]);
  Organisation.count.mockResolvedValue(2);
  Reserve.count.mockResolvedValue(0);
  Utilisateur.count.mockResolvedValue(0);
  Chantier.count.mockResolvedValue(0);
  Plan.count.mockResolvedValue(0);
});

/**
 * Le `where` du n-ième appel à `count` d'un modèle.
 *
 * L'ordre compte : les comptages de VOLUME (sans `where`) sont lancés en
 * premier dans le `Promise.all`, avant ceux de décision. Un même modèle est
 * donc compté plusieurs fois, et l'index reflète cette séquence.
 */
const whereDe = (modele, n) => modele.count.mock.calls[n]?.[0]?.where;

/** Rangs des appels, dans l'ordre du `Promise.all`. */
const RANG = {
  utilisateurVolume: 0, utilisateurEnAttente: 1, utilisateurRejete: 2,
  chantierVolume: 0, chantierEnAttente: 1, chantierRejete: 2, chantierActif: 3,
  reserveVolume: 0, reserveOuvertes: 1,
  planEnAttente: 0,
};

describe('compteurs de décision', () => {
  it('expose ce qui attend une décision, par nature', async () => {
    // Le premier appel de chaque modèle est son comptage de VOLUME.
    Utilisateur.count
      .mockResolvedValueOnce(999)  // volume
      .mockResolvedValueOnce(12)   // en attente
      .mockResolvedValueOnce(3);   // rejetées
    Chantier.count
      .mockResolvedValueOnce(999)  // volume
      .mockResolvedValueOnce(5)    // en attente
      .mockResolvedValueOnce(1)    // rejetés
      .mockResolvedValueOnce(40);  // actifs
    Plan.count.mockResolvedValue(7);

    const { stats } = await StatistiquesService.statsPlateforme();

    expect(stats.aValider).toEqual({ inscriptions: 12, chantiers: 5, plans: 7 });
    expect(stats.rejetes).toEqual({ inscriptions: 3, chantiers: 1 });
    expect(stats.chantiersActifs).toBe(40);
  });

  it('les compteurs de VOLUME restent intacts', async () => {
    // L'ajout ne doit rien retirer : l'écran affiche les deux familles.
    const { stats } = await StatistiquesService.statsPlateforme();

    expect(stats).toHaveProperty('organisations');
    expect(stats).toHaveProperty('utilisateurs');
    expect(stats).toHaveProperty('chantiers');
    expect(stats).toHaveProperty('reserves');
    expect(stats).toHaveProperty('reservesOuvertes');
    expect(stats).toHaveProperty('parAbonnement');
    expect(stats).toHaveProperty('reservesParStatut');
  });
});

describe('définitions', () => {
  it('« en attente » désigne bien le statut du circuit de validation', async () => {
    await StatistiquesService.statsPlateforme();

    expect(whereDe(Utilisateur, RANG.utilisateurEnAttente)).toEqual({ statut: 'en_attente_validation' });
    expect(whereDe(Chantier, RANG.chantierEnAttente)).toEqual({ statut: 'en_attente_validation' });
    expect(whereDe(Plan, RANG.planEnAttente)).toEqual({ statut: 'en_attente_validation' });
  });

  it('« chantier actif » exclut le circuit de demande, comme la liste', async () => {
    // La MÊME règle que `ChantierService` : un chantier en attente ou rejeté
    // n'existe pas encore comme chantier.
    await StatistiquesService.statsPlateforme();

    expect(whereDe(Chantier, RANG.chantierActif).statut).toEqual({
      [Op.notIn]: ['en_attente_validation', 'rejete'],
    });
  });

  it('les réserves ouvertes sont comptées dans le même aller-retour', async () => {
    // Ce comptage était `await`é après le `Promise.all`, donc en série : un
    // aller-retour de plus vers la base à chaque ouverture de l'écran le plus
    // consulté du super-admin.
    await StatistiquesService.statsPlateforme();

    expect(whereDe(Reserve, RANG.reserveOuvertes).statut).toEqual({
      [Op.notIn]: ['validee', 'cloturee'],
    });
  });
});
