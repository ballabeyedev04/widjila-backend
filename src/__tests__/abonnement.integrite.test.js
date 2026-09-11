'use strict';

/**
 * Tests — intégrité des abonnements (calculs et ordre des écritures).
 *
 *  1. Fin de période bornée au dernier jour du mois (31 janvier + 1 mois).
 *  2. Montant Stripe dans la plus petite unité de la devise (XOF sans ×100).
 *  3. Renouvellement anticipé de la même formule : la période s'enchaîne.
 *  4. Activation : expiration de la souscription en cours AVANT l'activation,
 *     le tout dans une transaction qui verrouille l'organisation.
 *
 * La concurrence réelle (deux activations simultanées) est vérifiée contre
 * PostgreSQL dans integration/abonnement.integration.test.js.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn() },
  PlanAbonnement: { findOne: jest.fn() },
  AbonnementSouscrit: { findOne: jest.fn(), findByPk: jest.fn(), update: jest.fn(), create: jest.fn() },
  EvenementPaiement: {},
  Utilisateur: {},
  Chantier: {},
}));
jest.mock('../modules/subscription/service/recuPaiement.service.js', () => ({ emettre: jest.fn() }));

const { Organisation, AbonnementSouscrit } = require('../models/index.js');
const sequelize = require('../config/db.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

const { calculerDateFin, montantStripe, debutPeriode } = SubscriptionService;

describe('calculerDateFin — pas de débordement de fin de mois', () => {
  it.each([
    ['2026-01-31T10:00:00Z', 'mois', '2026-02-28T10:00:00.000Z'],
    ['2028-01-31T10:00:00Z', 'mois', '2028-02-29T10:00:00.000Z'],
    ['2026-03-31T00:00:00Z', 'mois', '2026-04-30T00:00:00.000Z'],
    ['2026-12-15T08:30:00Z', 'mois', '2027-01-15T08:30:00.000Z'],
    ['2028-02-29T12:00:00Z', 'an', '2029-02-28T12:00:00.000Z'],
    ['2026-05-10T00:00:00Z', 'an', '2027-05-10T00:00:00.000Z'],
  ])('%s + 1 %s = %s', (debut, periode, attendu) => {
    expect(calculerDateFin(new Date(debut), periode).toISOString()).toBe(attendu);
  });
});

describe('montantStripe — plus petite unité de la devise', () => {
  it('centimes pour l’euro', () => expect(montantStripe('49.90', 'EUR')).toBe(4990));
  it('unités pour le franc CFA (sans décimale)', () => expect(montantStripe('32800', 'XOF')).toBe(32800));
  it('insensible à la casse', () => expect(montantStripe(10, 'xaf')).toBe(10));
});

describe('debutPeriode — renouvellement anticipé', () => {
  const dans10j = new Date(Date.now() + 10 * 86_400_000);

  it('même formule en cours : la nouvelle période s’enchaîne à l’échéance', () => {
    expect(debutPeriode({ plan_code: 'pro', date_fin: dans10j }, 'pro').getTime()).toBe(dans10j.getTime());
  });
  it('changement de formule : effet immédiat', () => {
    expect(debutPeriode({ plan_code: 'essentiel', date_fin: dans10j }, 'pro').getTime()).toBeLessThanOrEqual(Date.now());
  });
  it('aucune souscription en cours : maintenant', () => {
    expect(debutPeriode(null, 'pro').getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('_activerSousVerrou — ordre et atomicité', () => {
  let transaction;
  beforeEach(() => {
    jest.clearAllMocks();
    transaction = { LOCK: { UPDATE: 'UPDATE' } };
    jest.spyOn(sequelize, 'transaction').mockImplementation(async (fn) => fn(transaction));
    Organisation.findByPk.mockResolvedValue({ id: 'org', update: jest.fn() });
    AbonnementSouscrit.update.mockResolvedValue([1]);
  });

  it('verrouille l’organisation, expire la courante PUIS active — dans la même transaction', async () => {
    AbonnementSouscrit.findOne.mockResolvedValue({ id: 'ancienne', plan_code: 'pro', date_fin: new Date() });
    const nouvelle = { id: 'nouvelle', organisationId: 'org', statut: 'active', plan_nom: 'Pro' };
    const activer = jest.fn(async () => nouvelle);

    const res = await SubscriptionService._activerSousVerrou('org', async () => activer);

    expect(res).toBe(nouvelle);
    expect(Organisation.findByPk.mock.calls[0][1]).toMatchObject({ lock: 'UPDATE', transaction });
    expect(AbonnementSouscrit.update.mock.calls[0][1]).toMatchObject({ transaction });
    expect(AbonnementSouscrit.update.mock.invocationCallOrder[0]).toBeLessThan(activer.mock.invocationCallOrder[0]);
  });

  it('n’expire RIEN quand il n’y a rien à activer (rejeu)', async () => {
    AbonnementSouscrit.findOne.mockResolvedValue({ id: 'courante' });

    const res = await SubscriptionService._activerSousVerrou('org', async () => null);

    expect(res).toBeNull();
    expect(AbonnementSouscrit.update).not.toHaveBeenCalled();
  });

  it('une erreur pendant l’activation remonte (la transaction est annulée par Sequelize)', async () => {
    AbonnementSouscrit.findOne.mockResolvedValue(null);
    await expect(SubscriptionService._activerSousVerrou('org', async () => async () => {
      throw new Error('panne base');
    })).rejects.toThrow('panne base');
  });
});
