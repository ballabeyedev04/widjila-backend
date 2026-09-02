'use strict';

/**
 * Tests — service central des droits d'abonnement.
 *
 * C'est LUI qui décide de tout : les middlewares ne font que l'appeler. Ce qui
 * doit être verrouillé :
 *
 *   1. l'ORDRE de priorité — abonnement actif, puis essai, puis rien ;
 *   2. `null` (illimité) ne doit JAMAIS être confondu avec `0` ou `[]`, qui
 *      signifient l'inverse ;
 *   3. une souscription `en_attente` n'ouvre AUCUN droit — c'est ce qui
 *      empêche de s'abonner en abandonnant le paiement ;
 *   4. les limites sont vérifiées AVANT création, en tenant compte du nombre
 *      d'éléments que l'appel va créer ;
 *   5. un essai à `trial_ends_at` nul est TERMINÉ, pas éternel.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn(), findOne: jest.fn() },
  PlanAbonnement: { findOne: jest.fn(), findAll: jest.fn() },
  AbonnementSouscrit: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
  EvenementPaiement: { create: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

const {
  Organisation, AbonnementSouscrit, Utilisateur, Chantier,
} = require('../models/index.js');
const DroitsService = require('../modules/subscription/service/droits.service.js');

const ORG = 'org-1';

/** Organisation dont l'essai se termine dans `jours` (négatif = terminé). */
const orgAvecEssai = (jours) => ({
  id: ORG,
  trial_ends_at: new Date(Date.now() + jours * 24 * 3600 * 1000),
  is_subscribed: false,
});

/** Souscription active sur une formule donnée. */
const souscription = (plan, extra = {}) => ({
  id: 's1',
  organisationId: ORG,
  plan_code: plan.code,
  plan_nom: plan.nom,
  date_fin: null,
  plan,
  ...extra,
});

const PRO = {
  code: 'pro',
  nom: 'Pro',
  fonctionnalites: ['reserves', 'mobile', 'stockage', 'support_prioritaire', 'suivi_equipe', 'rapports', 'annotations', 'api'],
  limite_utilisateurs: 5,
  limite_chantiers: null,
};

const ESSENTIEL = {
  code: 'essentiel',
  nom: 'Essentiel',
  fonctionnalites: ['reserves', 'mobile', 'stockage', 'support_prioritaire'],
  limite_utilisateurs: 2,
  limite_chantiers: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  AbonnementSouscrit.findOne.mockResolvedValue(null);
  Utilisateur.count.mockResolvedValue(0);
  Chantier.count.mockResolvedValue(0);
});

describe('source des droits', () => {
  it('un abonnement actif l’emporte sur l’essai', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(5));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(PRO));

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('abonnement');
    expect(droits.planCode).toBe('pro');
    expect(droits.essaiEnCours).toBe(false);
  });

  it('sans abonnement, un essai en cours ouvre TOUT', async () => {
    // Aucun document client ne restreint l'essai : le brider inventerait une
    // règle commerciale.
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(3));

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('essai');
    expect(droits.fonctionnalites).toBeNull(); // null = toutes
    expect(droits.limiteUtilisateurs).toBeNull();
  });

  it('un essai terminé et aucun abonnement = aucun droit', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.actif).toBe(false);
    expect(droits.fonctionnalites).toEqual([]);
  });

  it('un `trial_ends_at` NUL vaut essai TERMINÉ, pas éternel', async () => {
    // Le piège corrigé en amont dans le modèle : une valeur nulle est falsy,
    // donc « essai non expiré », donc accès gratuit permanent.
    Organisation.findByPk.mockResolvedValue({ id: ORG, trial_ends_at: null, is_subscribed: false });

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.actif).toBe(false);
  });

  it('une organisation inconnue n’a aucun droit', async () => {
    Organisation.findByPk.mockResolvedValue(null);
    expect((await DroitsService.getDroits(ORG)).actif).toBe(false);
  });

  it('sans organisation, aucun droit — et aucune requête', async () => {
    const droits = await DroitsService.getDroits(null);
    expect(droits.actif).toBe(false);
    expect(Organisation.findByPk).not.toHaveBeenCalled();
  });
});

describe('souscription active — ce qui compte comme active', () => {
  it('ne retient que le statut `active`', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    await DroitsService.getDroits(ORG);

    // Une souscription `en_attente` (paiement engagé mais non confirmé) ne
    // doit rien ouvrir : c'est ce qui empêche de s'abonner en abandonnant le
    // paiement.
    expect(AbonnementSouscrit.findOne.mock.calls[0][0].where.statut).toBe('active');
  });

  it('accepte une échéance nulle comme non expirée', async () => {
    // Activation manuelle par l'administrateur : sans échéance connue, la
    // traiter comme expirée la tuerait à la seconde.
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(PRO, { date_fin: null }));

    expect((await DroitsService.getDroits(ORG)).actif).toBe(true);
  });
});

describe('fonctionnalités', () => {
  it('autorise une option incluse dans la formule', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(PRO));

    expect((await DroitsService.peutUtiliser(ORG, 'rapports')).autorise).toBe(true);
  });

  it('refuse une option absente de la formule', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL));

    const res = await DroitsService.peutUtiliser(ORG, 'rapports');

    expect(res.autorise).toBe(false);
    expect(res.raison).toBe('SUBSCRIPTION_FEATURE_UNAVAILABLE');
  });

  it('distingue « toutes » (null) de « aucune » (tableau vide)', async () => {
    // Les confondre ouvrirait tout aux organisations sans droits — la faute
    // la plus coûteuse possible ici.
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(3));
    expect((await DroitsService.peutUtiliser(ORG, 'api')).autorise).toBe(true);

    jest.clearAllMocks();
    AbonnementSouscrit.findOne.mockResolvedValue(null);
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    const refus = await DroitsService.peutUtiliser(ORG, 'api');
    expect(refus.autorise).toBe(false);
    expect(refus.raison).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('l’écart Essentiel / Pro correspond aux documents du client', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL));

    // Socle commun aux trois formules, d'après le visuel client.
    for (const socle of ['reserves', 'mobile', 'stockage', 'support_prioritaire']) {
      expect((await DroitsService.peutUtiliser(ORG, socle)).autorise).toBe(true);
    }
    // Options avancées, réservées à Pro et Entreprise.
    for (const avancee of ['suivi_equipe', 'rapports', 'annotations', 'api']) {
      expect((await DroitsService.peutUtiliser(ORG, avancee)).autorise).toBe(false);
    }
  });
});

describe('limites de volume', () => {
  it('refuse quand le plafond serait dépassé', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL)); // 2 utilisateurs
    Utilisateur.count.mockResolvedValue(2);

    const res = await DroitsService.verifierLimite(ORG, 'utilisateurs');

    expect(res.autorise).toBe(false);
    expect(res.raison).toBe('SUBSCRIPTION_LIMIT_REACHED');
    expect(res.limite).toBe(2);
    expect(res.courant).toBe(2);
  });

  it('autorise tant que le plafond n’est pas atteint', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL));
    Utilisateur.count.mockResolvedValue(1);

    expect((await DroitsService.verifierLimite(ORG, 'utilisateurs')).autorise).toBe(true);
  });

  it('tient compte du NOMBRE d’éléments que l’appel va créer', async () => {
    // Un import de contacts ajoute plusieurs comptes d'un coup : vérifier
    // « 1 de plus » laisserait dépasser le plafond en une seule requête.
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(PRO)); // 5 utilisateurs
    Utilisateur.count.mockResolvedValue(3);

    expect((await DroitsService.verifierLimite(ORG, 'utilisateurs', 2)).autorise).toBe(true);
    expect((await DroitsService.verifierLimite(ORG, 'utilisateurs', 3)).autorise).toBe(false);
  });

  it('une limite NULLE est illimitée, et ne déclenche aucun comptage', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(PRO)); // chantiers illimités

    const res = await DroitsService.verifierLimite(ORG, 'chantiers', 10000);

    expect(res.autorise).toBe(true);
    expect(Chantier.count).not.toHaveBeenCalled();
  });

  it('ne compte que les utilisateurs ACTIFS', async () => {
    // La présentation commerciale parle d'« utilisateurs actifs » : un compte
    // désactivé ne doit pas consommer de siège.
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL));

    await DroitsService.verifierLimite(ORG, 'utilisateurs');

    expect(Utilisateur.count.mock.calls[0][0].where.statut).toBe('actif');
  });

  it('sans abonnement ni essai, toute limite est refusée', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));

    const res = await DroitsService.verifierLimite(ORG, 'utilisateurs');

    expect(res.autorise).toBe(false);
    expect(res.raison).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('usage affiché', () => {
  it('renvoie le courant et la limite des deux ressources', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(-1));
    AbonnementSouscrit.findOne.mockResolvedValue(souscription(ESSENTIEL));
    Utilisateur.count.mockResolvedValue(1);
    Chantier.count.mockResolvedValue(4);

    const usage = await DroitsService.getUsage(ORG);

    expect(usage.utilisateurs).toEqual({ courant: 1, limite: 2 });
    expect(usage.chantiers).toEqual({ courant: 4, limite: null });
  });
});

describe('joursRestants — compte à rebours calculé côté serveur', () => {
  // Le mobile affiche cette valeur telle quelle. La calculer chez lui
  // reviendrait à faire confiance à l'horloge d'un téléphone de chantier,
  // parfois fausse de plusieurs jours — sur une information qui déclenche une
  // décision d'achat.
  it('arrondit au jour SUPÉRIEUR : une échéance dans 36 h vaut 2 jours', () => {
    const dans36h = new Date(Date.now() + 36 * 3600 * 1000);
    expect(DroitsService.joursRestants(dans36h)).toBe(2);
  });

  it('rend 0 et jamais un nombre négatif pour une échéance passée', () => {
    const hier = new Date(Date.now() - 48 * 3600 * 1000);
    expect(DroitsService.joursRestants(hier)).toBe(0);
  });

  it('rend null sans échéance — à distinguer de 0, qui veut dire « expire aujourd’hui »', () => {
    expect(DroitsService.joursRestants(null)).toBeNull();
    expect(DroitsService.joursRestants(undefined)).toBeNull();
  });

  it('accompagne les droits d’un essai en cours', async () => {
    Organisation.findByPk.mockResolvedValue(orgAvecEssai(10));
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('essai');
    expect(droits.joursRestants).toBe(10);
  });

  it('vaut null quand aucun droit n’est ouvert', async () => {
    Organisation.findByPk.mockResolvedValue(null);
    const droits = await DroitsService.getDroits(ORG);
    expect(droits.joursRestants).toBeNull();
  });
});
