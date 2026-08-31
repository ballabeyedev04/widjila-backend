'use strict';

/**
 * Tests — comptes SANS organisation (le super-admin plateforme).
 *
 * `getStatus` et `getPlanDetails` faisaient `Organisation.findByPk(null)`,
 * ne trouvaient rien, et le contrôleur traduisait cette absence en 403.
 *
 * C'était faux à deux titres : le super-admin a le DROIT d'appeler ces routes,
 * et il n'a simplement pas d'abonnement à déclarer. Conséquence visible : un
 * 403 dans la console à chaque page de l'espace d'administration, la mise en
 * page interrogeant ce statut partout.
 *
 * Ce qui doit être verrouillé :
 *   1. un compte sans organisation reçoit un statut NEUTRE, pas une erreur ;
 *   2. ce statut le distingue d'une organisation réellement sans abonnement,
 *      sinon l'interface lui proposerait de souscrire une formule dont il n'a
 *      que faire ;
 *   3. une organisation INTROUVABLE reste une erreur — c'est un identifiant
 *      qui ne correspond à rien, pas l'absence d'organisation.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn() },
  PlanAbonnement: { findAll: jest.fn().mockResolvedValue([]) },
  AbonnementSouscrit: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
  EvenementPaiement: { create: jest.fn(), findOne: jest.fn() },
  Utilisateur: { count: jest.fn().mockResolvedValue(0) },
  Chantier: { count: jest.fn().mockResolvedValue(0) },
}));

jest.mock('../modules/subscription/service/droits.service.js', () => ({
  getDroits: jest.fn().mockResolvedValue({
    actif: false, source: 'aucun', planCode: null, planNom: null,
    fonctionnalites: [], limiteUtilisateurs: 0, limiteChantiers: 0,
    essaiEnCours: false, dateFin: null,
  }),
  getUsage: jest.fn(),
  souscriptionActive: jest.fn(),
}));

const { Organisation } = require('../models/index.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

beforeEach(() => jest.clearAllMocks());

describe('getStatus — compte sans organisation', () => {
  it('répond avec succès plutôt qu’un refus', async () => {
    const res = await SubscriptionService.getStatus(null);

    // `success: false` deviendrait un 403 dans le contrôleur.
    expect(res.success).toBe(true);
  });

  it('n’interroge même pas la table des organisations', async () => {
    await SubscriptionService.getStatus(null);

    // `findByPk(null)` est une requête inutile, exécutée à chaque page.
    expect(Organisation.findByPk).not.toHaveBeenCalled();
  });

  it('signale que la question ne s’applique pas', async () => {
    const res = await SubscriptionService.getStatus(null);

    // Sans ce drapeau, l'interface afficherait « aucun abonnement » à un
    // super-admin qui n'a aucune raison d'en souscrire un.
    expect(res.status.sansOrganisation).toBe(true);
    expect(res.status.isSubscribed).toBe(false);
    expect(res.status.source).toBe('aucun');
  });

  it('n’annonce pas un essai expiré', async () => {
    const res = await SubscriptionService.getStatus(null);

    // `trialEnded: true` déclencherait les bandeaux d'expiration côté client.
    expect(res.status.trialEnded).toBe(false);
    expect(res.status.trialEndsAt).toBeNull();
  });
});

describe('getPlanDetails — compte sans organisation', () => {
  it('répond avec succès et sert quand même le catalogue', async () => {
    const res = await SubscriptionService.getPlanDetails(null);

    expect(res.success).toBe(true);
    // Le catalogue intéresse le super-admin : c'est lui qui l'administre.
    expect(Array.isArray(res.data.plans)).toBe(true);
    expect(res.data.souscription).toBeNull();
    expect(res.data.sansOrganisation).toBe(true);
  });
});

describe('organisation INTROUVABLE — reste une erreur', () => {
  it('getStatus échoue sur un identifiant qui ne correspond à rien', async () => {
    // Distinct du cas précédent : ici un identifiant est fourni, mais aucune
    // organisation ne lui correspond. C'est une anomalie, pas un cas normal.
    Organisation.findByPk.mockResolvedValue(null);

    const res = await SubscriptionService.getStatus('org-inexistante');

    expect(res.success).toBe(false);
    expect(res.message).toContain('introuvable');
  });

  it('getPlanDetails échoue de même', async () => {
    Organisation.findByPk.mockResolvedValue(null);

    const res = await SubscriptionService.getPlanDetails('org-inexistante');

    expect(res.success).toBe(false);
  });
});
