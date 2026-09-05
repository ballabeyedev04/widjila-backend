'use strict';

/**
 * Tests — modules/dashboard/service/dashboard.service.js
 *
 * ## Le défaut que ce fichier a fait apparaître
 *
 * `statsGlobales` construit un `where` qui décrit des CHANTIERS : filtre de
 * statut, et — depuis l'ajout du cloisonnement — un `demandeurId` et une
 * sous-requête sur `chantier_membres`. Ce même `where` était réutilisé tel
 * quel pour compter les UTILISATEURS de l'organisation.
 *
 * Aucune de ces colonnes n'existe sur `utilisateurs`. PostgreSQL rejetait
 * donc la requête, et l'écran d'accueil répondait 500 — pour tout rôle hors
 * gestion, c'est-à-dire pour les entreprises, clients, sous-traitants et
 * pilotes. Les rôles de gestion, eux, ne recevaient aucun cloisonnement et ne
 * voyaient rien.
 *
 * Les modèles étant simulés ici, une requête invalide ne lève pas : ce test
 * vérifie donc ce qui est réellement PASSÉ à `Utilisateur.count`, seul endroit
 * où le défaut est visible sans une vraie base.
 *
 * ## Le cache
 *
 * Deux comptes de la même organisation ne voient plus le même portefeuille
 * depuis le cloisonnement. Partager une entrée de cache leur servirait les
 * chiffres l'un de l'autre — une fuite entre comptes, silencieuse et
 * intermittente. La clé doit donc porter l'utilisateur DÈS QU'IL est
 * restreint, et lui seul : les rôles de gestion, cas le plus fréquent et le
 * plus coûteux, doivent continuer de partager une entrée unique.
 */

jest.mock('../models/index.js', () => ({
  Chantier: { findAll: jest.fn(), count: jest.fn() },
  Reserve: { findAll: jest.fn(), count: jest.fn() },
  Plan: { count: jest.fn() },
  Inspection: { count: jest.fn() },
  Document: { count: jest.fn() },
  Batiment: { findAll: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Partenaire: { findAll: jest.fn() },
  Etage: { findAll: jest.fn() },
}));

jest.mock('../utils/cache.js', () => ({
  lire: jest.fn(),
  ecrire: jest.fn(),
  invalider: jest.fn(),
}));

const { Op } = require('sequelize');
const { Chantier, Utilisateur } = require('../models/index.js');
const cache = require('../utils/cache.js');
const DashboardService = require('../modules/dashboard/service/dashboard.service.js');

const ORG = 'org-1';

/** Un compte d'entreprise : cloisonné, donc le cas qui plantait. */
const entreprise = { id: 'u-entreprise', role: 'Entreprise' };

/** Un compte de gestion : voit tout, aucun cloisonnement. */
const gestion = { id: 'u-gestion', role: 'ChefProjet' };

beforeEach(() => {
  jest.clearAllMocks();
  cache.lire.mockResolvedValue(null);
  cache.ecrire.mockResolvedValue(undefined);
  // Aucun chantier : `statsGlobales` s'arrête tôt, ce qui suffit — le compte
  // des utilisateurs, lui, a déjà été fait.
  Chantier.findAll.mockResolvedValue([]);
  Utilisateur.count.mockResolvedValue(7);
});

/** Le `where` réellement passé à `Utilisateur.count`. */
const whereDesComptes = () => Utilisateur.count.mock.calls[0][0].where;

describe('statsGlobales — portée du compte des utilisateurs', () => {
  it('compte les utilisateurs sur l’ORGANISATION, sans filtre de chantier', async () => {
    await DashboardService.statsGlobales(ORG, { auteur: gestion });

    expect(whereDesComptes()).toEqual({ organisationId: ORG });
  });

  it('un rôle CLOISONNÉ ne fait pas fuiter le filtre chantier dans les comptes', async () => {
    // Le cas qui provoquait le 500 : `demandeurId` et la sous-requête
    // `chantier_membres` n'existent pas sur la table des utilisateurs.
    await DashboardService.statsGlobales(ORG, { auteur: entreprise });

    const where = whereDesComptes();
    expect(where).toEqual({ organisationId: ORG });
    expect(where).not.toHaveProperty('demandeurId');
    expect(where).not.toHaveProperty('statut');
    expect(where[Op.and]).toBeUndefined();
    expect(where[Op.or]).toBeUndefined();
  });

  it('la vue « toutes organisations » ne filtre sur aucune organisation', async () => {
    await DashboardService.statsGlobales(null, {
      toutesOrganisations: true,
      auteur: { id: 'admin', role: 'Admin' },
    });

    expect(whereDesComptes()).toEqual({});
  });

  it('un ciblage explicite reste un filtre, même en vue globale', async () => {
    // Le super-admin qui consulte UN client : la portée globale ne doit pas
    // effacer l'organisation demandée.
    await DashboardService.statsGlobales(ORG, {
      toutesOrganisations: true,
      auteur: { id: 'admin', role: 'Admin' },
    });

    expect(whereDesComptes()).toEqual({ organisationId: ORG });
  });
});

describe('statsGlobales — portée du where CHANTIERS', () => {
  /** Le `where` réellement passé à `Chantier.findAll`. */
  const whereDesChantiers = () => Chantier.findAll.mock.calls[0][0].where;

  it('écarte TOUJOURS les demandes de création', async () => {
    // Un chantier en attente ou refusé n'existe pas encore : le compter
    // gonflerait l'accueil et le listerait comme un projet en cours.
    await DashboardService.statsGlobales(ORG, { auteur: gestion });

    expect(whereDesChantiers().statut).toEqual({
      [Op.notIn]: ['en_attente_validation', 'rejete'],
    });
  });

  it('applique le cloisonnement à un rôle restreint', async () => {
    await DashboardService.statsGlobales(ORG, { auteur: entreprise });

    // Le même cloisonnement que la liste des chantiers : sans lui, une
    // entreprise lisait « 1 chantier » face à une liste vide.
    expect(whereDesChantiers()[Op.and]).toBeDefined();
  });

  it('n’applique AUCUN cloisonnement à un rôle de gestion', async () => {
    await DashboardService.statsGlobales(ORG, { auteur: gestion });

    expect(whereDesChantiers()[Op.and]).toBeUndefined();
  });
});

describe('statsGlobales — clé de cache', () => {
  const cleUtilisee = () => cache.lire.mock.calls[0][0];

  it('un compte RESTREINT a sa propre entrée', async () => {
    await DashboardService.statsGlobales(ORG, { auteur: entreprise });

    expect(cleUtilisee()).toContain(entreprise.id);
  });

  it('deux comptes restreints ne partagent PAS d’entrée', async () => {
    // Le point qui compte : une entrée partagée servirait à l'un les chiffres
    // de l'autre, de façon intermittente et invisible.
    await DashboardService.statsGlobales(ORG, { auteur: entreprise });
    const premiere = cleUtilisee();

    cache.lire.mockClear();
    await DashboardService.statsGlobales(ORG, {
      auteur: { id: 'u-autre', role: 'Entreprise' },
    });

    expect(cleUtilisee()).not.toBe(premiere);
  });

  it('les rôles de GESTION continuent de partager une entrée unique', async () => {
    // C'est le cas le plus fréquent et le plus coûteux : lui donner une clé
    // par utilisateur reviendrait à désactiver le cache là où il sert le plus.
    await DashboardService.statsGlobales(ORG, { auteur: gestion });
    const premiere = cleUtilisee();

    cache.lire.mockClear();
    // `MaitreOuvrage` et non `ConducteurTravaux` : le groupe GESTION vaut
    // ['Admin', 'ChefProjet', 'MaitreOuvrage'] (roles.js). Un conducteur de
    // travaux EST cloisonne, et aurait donc — a juste titre — sa propre cle.
    await DashboardService.statsGlobales(ORG, {
      auteur: { id: 'u-autre-gestion', role: 'MaitreOuvrage' },
    });

    expect(cleUtilisee()).toBe(premiere);
  });

  it('la vue globale et une organisation absente ne se confondent pas', async () => {
    await DashboardService.statsGlobales(null, {
      toutesOrganisations: true,
      auteur: { id: 'admin', role: 'Admin' },
    });
    const globale = cleUtilisee();

    cache.lire.mockClear();
    await DashboardService.statsGlobales(null, { auteur: { id: 'admin', role: 'Admin' } });

    expect(cleUtilisee()).not.toBe(globale);
  });

  it('une entrée en cache court-circuite toute requête', async () => {
    cache.lire.mockResolvedValue({ success: true, stats: { chantiers: 3 } });

    const resultat = await DashboardService.statsGlobales(ORG, { auteur: gestion });

    expect(resultat.stats.chantiers).toBe(3);
    expect(Chantier.findAll).not.toHaveBeenCalled();
    expect(Utilisateur.count).not.toHaveBeenCalled();
  });
});

describe('statsGlobales — organisation sans chantier', () => {
  it('renvoie des zéros exploitables, jamais une erreur', async () => {
    // C'est ce que reçoit un compte qui vient de s'inscrire. L'écran mobile
    // s'en sert pour proposer sa page d'accueil guidée.
    const resultat = await DashboardService.statsGlobales(ORG, { auteur: gestion });

    expect(resultat.success).toBe(true);
    expect(resultat.stats.chantiers).toBe(0);
    expect(resultat.stats.parChantier).toEqual([]);
    expect(resultat.stats.reserves.total).toBe(0);
    // Le nombre de comptes, lui, reste réel : l'organisation existe.
    expect(resultat.stats.utilisateurs).toBe(7);
  });
});
