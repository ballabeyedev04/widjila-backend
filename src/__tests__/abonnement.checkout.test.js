'use strict';

/**
 * Tests — Stripe CHECKOUT (page de paiement hébergée) et état du paiement.
 *
 * Le parcours du web et du mobile passe désormais par la page de Stripe :
 * le serveur crée une session, le client y est redirigé, Stripe encaisse,
 * le webhook active. Ce qui est verrouillé ici :
 *
 *   1. le montant de la session vient de la BASE, le client n'envoie qu'un
 *      identifiant de formule ;
 *   2. créer la session n'ACTIVE rien : souscription `en_attente`, référencée
 *      par la session ;
 *   3. `checkout.session.completed` n'active que si `payment_status = paid`,
 *      et seulement si le montant ET la devise encaissés sont ceux de la
 *      souscription — un montant trafiqué n'ouvre rien ;
 *   4. une session expirée ou un paiement différé échoué classent la
 *      souscription sans jamais toucher à une souscription active ;
 *   5. l'état du paiement est cloisonné à l'organisation et ne dit jamais
 *      plus que ce que le webhook a établi.
 */

const mockStripe = {
  customers: { create: jest.fn() },
  paymentIntents: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn(), findOne: jest.fn() },
  PlanAbonnement: { findOne: jest.fn(), findAll: jest.fn() },
  AbonnementSouscrit: {
    findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn(),
  },
  EvenementPaiement: { create: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

jest.mock('../modules/subscription/service/recuPaiement.service.js', () => ({
  emettre: jest.fn().mockResolvedValue(),
}));

const sequelizeReel = require('../config/db.js');
beforeEach(() => {
  jest.spyOn(sequelizeReel, 'transaction').mockImplementation(async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
});

const {
  Organisation, PlanAbonnement, AbonnementSouscrit, EvenementPaiement,
} = require('../models/index.js');

process.env.STRIPE_SECRET_KEY = 'sk_test_pour_les_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pour_les_tests';
process.env.FRONTEND_URL = 'https://app.widjila.test/';

const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

const ORG = 'org-1';
const PRO = {
  id: 'plan-pro', code: 'pro', nom: 'Pro', description: 'desc',
  prix: '89.00', devise: 'EUR', periode: 'mois', actif: true,
  limite_utilisateurs: 5, limite_chantiers: null, fonctionnalites: ['reserves'], ordre: 20,
};

const organisation = (extra = {}) => ({
  id: ORG, nom: 'Widjila BTP', email: 'contact@example.com',
  stripe_customer_id: 'cus_123', trial_ends_at: null, is_subscribed: false,
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

/** Une souscription en base, avec un `update` qui applique ce qu'on lui donne. */
const souscription = (extra = {}) => {
  const s = {
    id: 's1', organisationId: ORG, plan_code: 'pro', plan_nom: 'Pro',
    prix_paye: '89.00', devise: 'EUR', periode: 'mois', statut: 'en_attente',
    fournisseur: 'stripe', reference_paiement: 'cs_test_1', stripe_customer_id: 'cus_123',
    createdAt: new Date('2026-09-19T10:00:00Z'), date_debut: null, date_fin: null,
    ...extra,
  };
  s.update = jest.fn(async (v) => Object.assign(s, v));
  return s;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStripe.checkout.sessions.create.mockResolvedValue({
    id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  });
  AbonnementSouscrit.create.mockResolvedValue({ id: 's1' });
  AbonnementSouscrit.update.mockResolvedValue([0]);
  EvenementPaiement.create.mockResolvedValue({ id: 'e1', update: jest.fn().mockResolvedValue() });
});

describe('création de la session Checkout', () => {
  it('facture le prix de la BASE, en mode paiement, avec les adresses de retour', async () => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    const res = await SubscriptionService.creerCheckoutSession(ORG, 'pro', 'user-1');

    expect(res.success).toBe(true);
    expect(res.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(res.sessionId).toBe('cs_test_1');

    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.mode).toBe('payment');
    expect(params.customer).toBe('cus_123');
    expect(params.line_items[0].price_data.unit_amount).toBe(8900);
    expect(params.line_items[0].price_data.currency).toBe('eur');
    expect(params.success_url).toBe('https://app.widjila.test/abonnement?paiement=retour&session={CHECKOUT_SESSION_ID}');
    expect(params.cancel_url).toBe('https://app.widjila.test/abonnement?paiement=annule');
    expect(params.metadata).toEqual({ organisationId: ORG, planId: 'plan-pro', planCode: 'pro' });
    expect(params.payment_intent_data.metadata).toEqual(params.metadata);
    // Bornée dans le temps : une session oubliée ne reste pas payable des jours.
    // Stripe exige au moins 30 minutes à réception : on en donne 35.
    expect(params.expires_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60);
    expect(params.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 35 * 60 + 5);
  });

  it("n'active RIEN : souscription en attente, référencée par la session, prix figé", async () => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    await SubscriptionService.creerCheckoutSession(ORG, 'pro', 'user-1');

    expect(AbonnementSouscrit.create).toHaveBeenCalledTimes(1);
    expect(AbonnementSouscrit.create.mock.calls[0][0]).toMatchObject({
      organisationId: ORG, plan_code: 'pro', prix_paye: 89, devise: 'EUR',
      statut: 'en_attente', fournisseur: 'stripe', reference_paiement: 'cs_test_1',
      activee_par: 'user-1',
    });
    // Aucune écriture sur l'organisation, aucun droit accordé.
    expect(Organisation.findByPk.mock.results[0].value).resolves.toMatchObject({ is_subscribed: false });
  });

  it('crée le client Stripe une seule fois et le mémorise sur l’organisation', async () => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    const org = organisation({ stripe_customer_id: null });
    Organisation.findByPk.mockResolvedValue(org);
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

    await SubscriptionService.creerCheckoutSession(ORG, 'pro');

    expect(mockStripe.customers.create).toHaveBeenCalledTimes(1);
    expect(org.update).toHaveBeenCalledWith({ stripe_customer_id: 'cus_new' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_new');
  });

  it.each([
    ['inconnue', null, 'Formule inconnue'],
    ['désactivée', { ...PRO, actif: false }, 'plus proposée'],
    ['sur devis', { ...PRO, prix: null }, 'sur devis'],
  ])('refuse une formule %s sans rien créer', async (_l, plan, message) => {
    PlanAbonnement.findOne.mockResolvedValue(plan);
    Organisation.findByPk.mockResolvedValue(organisation());

    const res = await SubscriptionService.creerCheckoutSession(ORG, 'pro');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(new RegExp(message, 'i'));
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
  });
});

describe('webhook Checkout — seule la session PAYÉE active, au bon montant', () => {
  const evenement = (type, objet) => {
    mockStripe.webhooks.constructEvent.mockReturnValue({ id: `evt_${type}`, type, data: { object: objet } });
    return SubscriptionService.handleWebhook('{}', 'sig');
  };
  const sessionPayee = (extra = {}) => ({
    id: 'cs_test_1', customer: 'cus_123', payment_status: 'paid',
    amount_total: 8900, currency: 'eur', ...extra,
  });

  beforeEach(() => {
    Organisation.findByPk.mockResolvedValue(organisation());
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => {
      if (where.reference_paiement === 'cs_test_1') return souscription();
      return null; // pas de souscription active courante
    });
  });

  it('`checkout.session.completed` payée → la souscription devient active', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => (where.reference_paiement === 'cs_test_1' ? s : null));
    AbonnementSouscrit.findByPk.mockResolvedValue(s);

    const res = await evenement('checkout.session.completed', sessionPayee());

    expect(res.success).toBe(true);
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ statut: 'active' }), expect.anything());
    expect(s.date_fin).toBeInstanceOf(Date);
  });

  it('`completed` avec `payment_status: unpaid` (paiement différé) → RIEN n’est activé', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockResolvedValue(s);

    await evenement('checkout.session.completed', sessionPayee({ payment_status: 'unpaid' }));

    expect(s.update).not.toHaveBeenCalled();
    expect(s.statut).toBe('en_attente');
  });

  it('`async_payment_succeeded` confirme ensuite le paiement différé', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => (where.reference_paiement === 'cs_test_1' ? s : null));
    AbonnementSouscrit.findByPk.mockResolvedValue(s);

    await evenement('checkout.session.async_payment_succeeded', sessionPayee());

    expect(s.statut).toBe('active');
  });

  it.each([
    ['montant inférieur', { amount_total: 100 }],
    ['montant supérieur', { amount_total: 890000 }],
    ['autre devise', { currency: 'usd' }],
  ])('refuse d’activer sur un %s encaissé', async (_l, ecart) => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockResolvedValue(s);

    const res = await evenement('checkout.session.completed', sessionPayee(ecart));

    // 200 pour Stripe (l'événement est bien reçu et journalisé) — mais rien
    // n'est ouvert : l'écart se règle à la main, pas en accordant la formule.
    expect(res.success).toBe(true);
    expect(s.update).not.toHaveBeenCalled();
    expect(s.statut).toBe('en_attente');
  });

  it('`checkout.session.expired` classe la souscription en attente comme annulée', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockResolvedValue(s);

    await evenement('checkout.session.expired', { id: 'cs_test_1' });

    expect(s.statut).toBe('annulee');
  });

  it('`checkout.session.expired` ne touche pas à une souscription déjà active', async () => {
    const s = souscription({ statut: 'active' });
    AbonnementSouscrit.findOne.mockResolvedValue(s);

    await evenement('checkout.session.expired', { id: 'cs_test_1' });

    expect(s.update).not.toHaveBeenCalled();
    expect(s.statut).toBe('active');
  });

  it('`async_payment_failed` marque l’échec', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockResolvedValue(s);

    await evenement('checkout.session.async_payment_failed', { id: 'cs_test_1' });

    expect(s.statut).toBe('echec');
  });

  it('une signature invalide est rejetée avant tout traitement', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('No signatures found'); });

    const res = await SubscriptionService.handleWebhook('{}', 'mauvaise');

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(EvenementPaiement.create).not.toHaveBeenCalled();
  });

  it('le même événement rejoué est un doublon : une seule activation', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => (where.reference_paiement === 'cs_test_1' ? s : null));
    AbonnementSouscrit.findByPk.mockResolvedValue(s);
    await evenement('checkout.session.completed', sessionPayee());
    expect(s.update).toHaveBeenCalledTimes(1);

    // Rejeu : le journal refuse le doublon (contrainte unique), et le
    // premier passage a abouti (pas d'erreur) → ignoré.
    const { UniqueConstraintError } = require('sequelize');
    EvenementPaiement.create.mockRejectedValueOnce(new UniqueConstraintError({ message: 'dup', errors: [] }));
    EvenementPaiement.update.mockResolvedValue([0]);

    const res = await evenement('checkout.session.completed', sessionPayee());

    expect(res.duplicate).toBe(true);
    expect(s.update).toHaveBeenCalledTimes(1);
  });
});

describe('état du paiement — ce que le serveur sait, cloisonné', () => {
  beforeEach(() => {
    Organisation.findByPk.mockResolvedValue(organisation());
  });

  it('rend la souscription visée et les droits courants', async () => {
    const s = souscription({ statut: 'active', date_debut: new Date('2026-09-19'), date_fin: new Date('2026-10-19') });
    AbonnementSouscrit.findOne.mockImplementation(async ({ where, include }) => {
      // `DroitsService.souscriptionActive` (include plan) ou la recherche par référence
      if (include) return { ...s, plan: PRO };
      return where.reference_paiement === 'cs_test_1' ? s : null;
    });

    const res = await SubscriptionService.getEtatPaiement(ORG, 'cs_test_1');

    expect(res.success).toBe(true);
    expect(res.paiement).toMatchObject({ reference: 'cs_test_1', statut: 'active', planCode: 'pro', prix: 89 });
    expect(res.droits).toMatchObject({ actif: true, source: 'abonnement', planCode: 'pro' });
    // La requête porte TOUJOURS l'organisation du jeton : pas de lecture croisée.
    expect(AbonnementSouscrit.findOne.mock.calls[0][0].where).toMatchObject({ organisationId: ORG, reference_paiement: 'cs_test_1' });
  });

  it("une référence d'une autre organisation est introuvable (404)", async () => {
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    const res = await SubscriptionService.getEtatPaiement(ORG, 'cs_test_autre');

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  it('sans référence : le dernier paiement Stripe engagé, ou aucun', async () => {
    AbonnementSouscrit.findOne.mockImplementation(async ({ where, include }) => {
      if (include) return null;
      expect(where).toMatchObject({ organisationId: ORG, fournisseur: 'stripe' });
      return souscription();
    });

    const res = await SubscriptionService.getEtatPaiement(ORG);
    expect(res.success).toBe(true);
    expect(res.paiement.statut).toBe('en_attente');
    expect(res.droits.source).toBe('aucun');

    AbonnementSouscrit.findOne.mockResolvedValue(null);
    const vide = await SubscriptionService.getEtatPaiement(ORG);
    expect(vide.success).toBe(true);
    expect(vide.paiement).toBeNull();
  });

  it('un compte sans organisation n’a pas de paiement', async () => {
    const res = await SubscriptionService.getEtatPaiement(null, 'cs_test_1');
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(404);
  });
});
