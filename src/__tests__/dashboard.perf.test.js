'use strict';

/**
 * Tests — le tableau de bord ne vide plus le pool de connexions.
 *
 * ## Le défaut, mesuré sur le code
 *
 * `statsGlobales` lançait DOUZE requêtes en parallèle par appel (huit sur
 * `reserves`), `statsChantier` DIX. Chaque requête parallèle tient une
 * connexion ; un worker en a 20. Deux ouvertures simultanées de l'accueil
 * suffisaient à épuiser le pool, et toutes les autres requêtes du worker
 * attendaient derrière (jusqu'au délai d'acquisition).
 *
 * ## Ce qui est mesuré ici
 *
 * Les modèles sont doublés par des fonctions qui répondent après 10 ms et
 * COMPTENT les requêtes en vol simultanément — c'est exactement le nombre de
 * connexions qu'un appel mobiliserait. On vérifie aussi que les chiffres
 * restent justes : ils sortent désormais d'une seule requête groupée.
 */

const enVol = { courant: 0, max: 0, total: 0 };

function requete(valeur) {
  return jest.fn(async () => {
    enVol.courant += 1;
    enVol.total += 1;
    enVol.max = Math.max(enVol.max, enVol.courant);
    await new Promise((r) => setTimeout(r, 10));
    enVol.courant -= 1;
    return typeof valeur === 'function' ? valeur() : valeur;
  });
}

// Réserves groupées (chantier, statut, sévérité) + échues — telles que
// PostgreSQL les rendrait (COUNT en chaînes, comme le pilote `pg`).
const LIGNES = [
  { chantierId: 'c1', statut: 'creee', severite: 'haute', n: '3', echues: '1' },
  { chantierId: 'c1', statut: 'validee', severite: 'faible', n: '2', echues: '2' },
  { chantierId: 'c2', statut: 'refusee', severite: 'moyenne', n: '1', echues: '0' },
  { chantierId: 'c2', statut: 'en_cours', severite: 'haute', n: '4', echues: '3' },
];

jest.mock('../models/index.js', () => ({
  Chantier: { findAll: jest.fn(), findOne: jest.fn() },
  Reserve: { findAll: jest.fn(), count: jest.fn() },
  Plan: { count: jest.fn() },
  Inspection: { count: jest.fn() },
  Document: { count: jest.fn() },
  Batiment: { findAll: jest.fn(), count: jest.fn() },
  Utilisateur: { count: jest.fn() },
  ReserveHistorique: {},
  Organisation: {},
}));

const models = require('../models/index.js');
const cache = require('../utils/cache.js');
const DashboardService = require('../modules/dashboard/service/dashboard.service.js');

const GESTION = { id: 'u-chef', role: 'ChefProjet' };

beforeEach(() => {
  enVol.courant = 0; enVol.max = 0; enVol.total = 0;
  cache._memoire.vider();
  models.Chantier.findAll = requete([
    { id: 'c1', nom: 'Tour A', code: 'TA', statut: 'en_cours' },
    { id: 'c2', nom: 'Tour B', code: 'TB', statut: 'en_cours' },
  ]);
  models.Chantier.findOne = requete({ id: 'c1', nom: 'Tour A' });
  models.Reserve.findAll = requete(() => LIGNES.map((l) => ({ ...l })));
  models.Reserve.count = requete(0);
  models.Plan.count = requete(5);
  models.Inspection.count = requete(2);
  models.Document.count = requete(9);
  models.Batiment.findAll = requete([{ chantierId: 'c1', n: '2' }]);
  models.Batiment.count = requete(2);
  models.Utilisateur.count = requete(12);
});

describe('statsGlobales', () => {
  it('ne mobilise pas plus de 5 connexions à la fois (12 auparavant)', async () => {
    await DashboardService.statsGlobales('org-1', { auteur: GESTION });

    expect(enVol.max).toBeLessThanOrEqual(5);
  });

  it('interroge `reserves` UNE fois au lieu de huit', async () => {
    await DashboardService.statsGlobales('org-1', { auteur: GESTION });

    expect(models.Reserve.findAll).toHaveBeenCalledTimes(1);
    expect(models.Reserve.count).not.toHaveBeenCalled();
  });

  it('les compteurs restent exacts', async () => {
    const { stats } = await DashboardService.statsGlobales('org-1', { auteur: GESTION });

    expect(stats.reserves).toEqual({ total: 10, ouvertes: 8, validees: 2, refusees: 1, enRetard: 4 });
    // « En retard » exclut les réserves fermées : les 2 échues validées ne comptent pas.
    expect(stats.parStatut).toEqual({ creee: 3, validee: 2, refusee: 1, en_cours: 4 });
    expect(stats.parSeverite).toEqual({ haute: 7, faible: 2, moyenne: 1 });
    expect(stats.parChantier).toEqual([
      { id: 'c1', nom: 'Tour A', code: 'TA', statut: 'en_cours', reserves: { total: 5, ouvertes: 3 }, batiments: 2 },
      { id: 'c2', nom: 'Tour B', code: 'TB', statut: 'en_cours', reserves: { total: 5, ouvertes: 5 }, batiments: 0 },
    ]);
    expect(stats).toEqual(expect.objectContaining({ plans: 5, inspections: 2, documents: 9, utilisateurs: 12, chantiers: 2 }));
  });

  it('50 ouvertures simultanées de l’accueil partagent UN seul calcul', async () => {
    await Promise.all(Array.from({ length: 50 }, () => DashboardService.statsGlobales('org-1', { auteur: GESTION })));

    expect(models.Chantier.findAll).toHaveBeenCalledTimes(1);
    expect(models.Reserve.findAll).toHaveBeenCalledTimes(1);
    expect(enVol.max).toBeLessThanOrEqual(5);
  });

  it('sans Redis, l’accueil est servi depuis le cache du process pendant son TTL', async () => {
    await DashboardService.statsGlobales('org-1', { auteur: GESTION });
    const requetesApresPremier = enVol.total;

    await DashboardService.statsGlobales('org-1', { auteur: GESTION });

    expect(enVol.total).toBe(requetesApresPremier);
  });
});

describe('statsChantier', () => {
  it('ne mobilise pas plus de 5 connexions à la fois (10 auparavant)', async () => {
    await DashboardService.statsChantier('org-1', 'c1');

    // findOne d'abord (1), puis 5 en parallèle.
    expect(enVol.max).toBeLessThanOrEqual(5);
    expect(models.Reserve.findAll).toHaveBeenCalledTimes(1);
    expect(models.Reserve.count).not.toHaveBeenCalled();
  });

  it('les compteurs restent exacts', async () => {
    const { stats } = await DashboardService.statsChantier('org-1', 'c1');

    expect(stats.reserves).toEqual({ total: 10, ouvertes: 8, validees: 2, enRetard: 4 });
    expect(stats.parStatut).toEqual({ creee: 3, validee: 2, refusee: 1, en_cours: 4 });
    expect(stats.parSeverite).toEqual({ haute: 7, faible: 2, moyenne: 1 });
    expect(stats).toEqual(expect.objectContaining({ batiments: 2, plans: 5, inspections: 2, documents: 9 }));
  });

  it('10 ouvertures simultanées du même chantier partagent un calcul', async () => {
    await Promise.all(Array.from({ length: 10 }, () => DashboardService.statsChantier('org-1', 'c1')));

    expect(models.Chantier.findOne).toHaveBeenCalledTimes(1);
  });

  it('n’est pas mis en cache au-delà de l’instant (une réserve créée doit se voir)', async () => {
    await DashboardService.statsChantier('org-1', 'c1');
    await DashboardService.statsChantier('org-1', 'c1');

    expect(models.Chantier.findOne).toHaveBeenCalledTimes(2);
  });
});
