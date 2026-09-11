'use strict';

/**
 * Tests — paiement et webhook.
 *
 * Ce sont les deux endroits où une erreur coûte de l'argent ou ouvre un accès
 * non payé. Ce qui est verrouillé :
 *
 *   1. le MONTANT vient de la base, jamais du client ;
 *   2. une formule « sur devis » ou désactivée n'est pas facturable ;
 *   3. créer une intention de paiement n'ACTIVE RIEN — seul le webhook le fait ;
 *   4. une signature invalide est rejetée AVANT tout traitement ;
 *   5. un même événement rejoué ne réactive rien (idempotence) ;
 *   6. le prix payé est FIGÉ dans l'historique.
 */

const mockStripe = {
  customers: { create: jest.fn() },
  paymentIntents: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn(), findOne: jest.fn() },
  PlanAbonnement: { findOne: jest.fn(), findAll: jest.fn() },
  AbonnementSouscrit: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
  EvenementPaiement: { create: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

const { UniqueConstraintError } = require('sequelize');
const {
  Organisation, PlanAbonnement, AbonnementSouscrit, EvenementPaiement,
} = require('../models/index.js');

process.env.STRIPE_SECRET_KEY = 'sk_test_pour_les_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pour_les_tests';

const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

const ORG = 'org-1';

const PRO = {
  id: 'plan-pro', code: 'pro', nom: 'Pro', description: 'desc',
  prix: '89.00', devise: 'EUR', periode: 'mois', actif: true,
  limite_utilisateurs: 5, limite_chantiers: null,
  fonctionnalites: ['reserves', 'rapports'], ordre: 20,
};

const ENTREPRISE = { ...PRO, id: 'plan-ent', code: 'entreprise', nom: 'Entreprise', prix: null };

const organisation = (extra = {}) => ({
  id: ORG, nom: 'Widjila BTP', email: 'contact@example.com',
  stripe_customer_id: null,
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStripe.customers.create.mockResolvedValue({ id: 'cus_123' });
  mockStripe.paymentIntents.create.mockResolvedValue({
    id: 'pi_123', client_secret: 'pi_123_secret',
  });
  AbonnementSouscrit.create.mockResolvedValue({ id: 's1' });
  AbonnementSouscrit.update.mockResolvedValue([0]);
  EvenementPaiement.create.mockResolvedValue({ id: 'e1', update: jest.fn().mockResolvedValue() });
});

describe('création du paiement — le montant vient du serveur', () => {
  it('facture le prix de la BASE, pas celui envoyé par le client', async () => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    // Le service ne prend qu'un identifiant : il n'y a même pas de paramètre
    // par lequel un prix pourrait entrer.
    await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    expect(mockStripe.paymentIntents.create.mock.calls[0][0].amount).toBe(8900);
    expect(mockStripe.paymentIntents.create.mock.calls[0][0].currency).toBe('eur');
  });

  it('refuse une formule « sur devis »', async () => {
    // Sans montant négocié, facturer reviendrait à encaisser 0 €.
    PlanAbonnement.findOne.mockResolvedValue(ENTREPRISE);
    Organisation.findByPk.mockResolvedValue(organisation());

    const res = await SubscriptionService.creerPaymentIntent(ORG, 'entreprise');

    expect(res.success).toBe(false);
    expect(res.code).toBe('SUBSCRIPTION_QUOTE_REQUIRED');
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('refuse une formule désactivée', async () => {
    PlanAbonnement.findOne.mockResolvedValue({ ...PRO, actif: false });
    Organisation.findByPk.mockResolvedValue(organisation());

    const res = await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    expect(res.success).toBe(false);
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('refuse une formule inconnue', async () => {
    PlanAbonnement.findOne.mockResolvedValue(null);
    const res = await SubscriptionService.creerPaymentIntent(ORG, 'formule-inexistante');
    expect(res.success).toBe(false);
  });

  it('n’ACTIVE rien : la souscription naît « en attente »', async () => {
    // C'est ce qui empêche de s'abonner en abandonnant le paiement.
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    const creee = AbonnementSouscrit.create.mock.calls[0][0];
    expect(creee.statut).toBe('en_attente');
    expect(creee.date_debut).toBeUndefined();
  });

  it('FIGE le prix dans l’historique dès la souscription', async () => {
    // Un changement de tarif ultérieur ne doit pas réécrire ce qui a été
    // proposé au client.
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    const creee = AbonnementSouscrit.create.mock.calls[0][0];
    expect(creee.prix_paye).toBe(89);
    expect(creee.plan_code).toBe('pro');
    expect(creee.plan_nom).toBe('Pro');
  });

  it('réutilise le client Stripe existant', async () => {
    // En recréer un dupliquerait le contact et disperserait la facturation.
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation({ stripe_customer_id: 'cus_deja' }));

    await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.create.mock.calls[0][0].customer).toBe('cus_deja');
  });

  it('transporte de quoi retrouver le destinataire dans le webhook', async () => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    Organisation.findByPk.mockResolvedValue(organisation());

    await SubscriptionService.creerPaymentIntent(ORG, 'pro');

    expect(mockStripe.paymentIntents.create.mock.calls[0][0].metadata).toMatchObject({
      organisationId: ORG, planCode: 'pro',
    });
  });
});

describe('webhook — signature', () => {
  it('rejette une signature invalide sans rien traiter', async () => {
    // Sans ce verrou, n'importe qui s'offrirait un abonnement en postant un
    // faux « paiement réussi ».
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('signature mismatch');
    });

    const res = await SubscriptionService.handleWebhook(Buffer.from('{}'), 'sig-bidon');

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(EvenementPaiement.create).not.toHaveBeenCalled();
  });
});

describe('webhook — idempotence', () => {
  it('ignore un événement déjà reçu, et répond quand même 2xx', async () => {
    // Stripe réémet tant qu'il n'a pas de 2xx : répondre en erreur
    // relancerait la boucle indéfiniment.
    EvenementPaiement.create.mockRejectedValue(new UniqueConstraintError({ errors: [] }));
    // Déjà reçu ET déjà traité : aucune ligne « en échec » à réclamer.
    EvenementPaiement.update.mockResolvedValue([0]);

    const res = await SubscriptionService.traiterEvenement(
      'stripe', 'evt_1', 'payment_intent.succeeded', { id: 'pi_1' }
    );

    expect(res.success).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(AbonnementSouscrit.findOne).not.toHaveBeenCalled();
  });

  it('RETRAITE un événement déjà reçu dont le traitement n’avait pas abouti', async () => {
    // Premier passage en échec (base indisponible) → 500 → Stripe réémet.
    // Classer la réémission en « doublon » perdait l'activation pour de bon.
    EvenementPaiement.create.mockRejectedValue(new UniqueConstraintError({ errors: [] }));
    EvenementPaiement.update.mockResolvedValue([1]); // la reprise est réclamée
    const journal = { id: 'e1', traite_le: null, update: jest.fn().mockResolvedValue() };
    EvenementPaiement.findOne.mockResolvedValue(journal);
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    const res = await SubscriptionService.traiterEvenement(
      'stripe', 'evt_1', 'payment_intent.succeeded', { id: 'pi_1' }
    );

    expect(res.duplicate).toBeUndefined();
    expect(AbonnementSouscrit.findOne).toHaveBeenCalled();
    expect(journal.update).toHaveBeenCalledWith({ traite_le: expect.any(Date) });
    // Réclamation CONDITIONNELLE : uniquement une ligne en échec, jamais traitée.
    const [, options] = EvenementPaiement.update.mock.calls[0];
    expect(options.where).toMatchObject({ evenement_id: 'evt_1', traite_le: null });
  });

  it('une réémission CONCURRENTE d’un traitement encore en cours est un doublon', async () => {
    // Premier passage en cours : ni `traite_le`, ni `erreur`. Le retraiter
    // en parallèle expirait la souscription que le premier venait de créer.
    EvenementPaiement.create.mockRejectedValue(new UniqueConstraintError({ errors: [] }));
    EvenementPaiement.update.mockResolvedValue([0]);

    const res = await SubscriptionService.traiterEvenement(
      'paytech', 'ref_1', 'sale_complete', { organisationId: 'org-1', planId: 'pro', reference: 'ref_1' }
    );

    expect(res.duplicate).toBe(true);
    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
  });

  it('customer.subscription.updated ne prolonge PAS la période (seule invoice.paid le fait)', async () => {
    // Un renouvellement émet les deux événements : les deux prolongeaient,
    // soit deux périodes pour un seul paiement — et un changement de carte
    // prolongeait sans aucun encaissement.
    const journal = { id: 'e2', update: jest.fn().mockResolvedValue() };
    EvenementPaiement.create.mockResolvedValue(journal);

    await SubscriptionService.traiterEvenement(
      'stripe', 'evt_upd', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' }
    );

    expect(Organisation.findOne).not.toHaveBeenCalled();
    expect(AbonnementSouscrit.findOne).not.toHaveBeenCalled();
  });

  it('journalise AVANT de traiter, pour distinguer « jamais vu » de « échoué »', async () => {
    const journal = { id: 'e1', update: jest.fn().mockResolvedValue() };
    EvenementPaiement.create.mockResolvedValue(journal);
    AbonnementSouscrit.findOne.mockResolvedValue(null); // rien à activer

    await SubscriptionService.traiterEvenement(
      'stripe', 'evt_2', 'payment_intent.succeeded', { id: 'pi_2' }
    );

    expect(EvenementPaiement.create).toHaveBeenCalled();
    expect(journal.update).toHaveBeenCalledWith({ traite_le: expect.any(Date) });
  });

  it('garde la trace d’un traitement échoué, sans `traite_le`', async () => {
    const journal = { id: 'e1', update: jest.fn().mockResolvedValue() };
    EvenementPaiement.create.mockResolvedValue(journal);
    AbonnementSouscrit.findOne.mockRejectedValue(new Error('base indisponible'));

    await expect(SubscriptionService.traiterEvenement(
      'stripe', 'evt_3', 'payment_intent.succeeded', { id: 'pi_3' }
    )).rejects.toThrow('base indisponible');

    expect(journal.update).toHaveBeenCalledWith({ erreur: 'base indisponible' });
  });
});

describe('webhook — activation', () => {
  it('active la souscription attachée au paiement confirmé', async () => {
    const souscription = {
      id: 's1', organisationId: ORG, statut: 'en_attente', periode: 'mois',
      stripe_customer_id: null, plan_code: 'pro', plan_nom: 'Pro',
      update: jest.fn().mockResolvedValue(),
    };
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);
    Organisation.findByPk.mockResolvedValue(organisation());

    await SubscriptionService._activerDepuisPaiement('pi_1', 'cus_1');

    const maj = souscription.update.mock.calls[0][0];
    expect(maj.statut).toBe('active');
    expect(maj.date_debut).toBeInstanceOf(Date);
    // L'échéance suit la période : un mois pour une formule mensuelle.
    expect(maj.date_fin.getTime()).toBeGreaterThan(maj.date_debut.getTime());
  });

  it('ne réactive pas une souscription déjà active', async () => {
    const souscription = {
      id: 's1', organisationId: ORG, statut: 'active',
      update: jest.fn().mockResolvedValue(),
    };
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement('pi_1', 'cus_1');

    expect(souscription.update).not.toHaveBeenCalled();
  });

  it('retrouve la souscription par la RÉFÉRENCE du paiement', async () => {
    // Et non par les métadonnées : la référence identifie sans ambiguïté la
    // ligne créée en attente, avec son prix proposé.
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    await SubscriptionService._activerDepuisPaiement('pi_42', 'cus_1');

    expect(AbonnementSouscrit.findOne.mock.calls[0][0].where.reference_paiement).toBe('pi_42');
  });

  it('un paiement échoué ne touche PAS une souscription déjà active', async () => {
    // Un échec de renouvellement ne doit pas effacer le mois déjà payé.
    const active = { statut: 'active', update: jest.fn().mockResolvedValue() };
    AbonnementSouscrit.findOne.mockResolvedValue(active);

    await SubscriptionService._marquerEchec('pi_1');

    expect(active.update).not.toHaveBeenCalled();
  });

  it('un paiement échoué marque bien la souscription en attente', async () => {
    const attente = { statut: 'en_attente', update: jest.fn().mockResolvedValue() };
    AbonnementSouscrit.findOne.mockResolvedValue(attente);

    await SubscriptionService._marquerEchec('pi_1');

    expect(attente.update).toHaveBeenCalledWith({ statut: 'echec' });
  });
});

describe('catalogue', () => {
  it('ne renvoie que les formules actives, dans l’ordre défini', async () => {
    PlanAbonnement.findAll.mockResolvedValue([PRO]);

    const plans = await SubscriptionService.getPlans();

    expect(PlanAbonnement.findAll.mock.calls[0][0].where).toEqual({ actif: true });
    expect(PlanAbonnement.findAll.mock.calls[0][0].order[0]).toEqual(['ordre', 'ASC']);
    expect(plans[0].prix).toBe(89);
  });

  it('signale « sur devis » plutôt que d’afficher un prix nul', async () => {
    // Renvoyer 0 confondrait « gratuit » et « nous consulter ».
    PlanAbonnement.findAll.mockResolvedValue([ENTREPRISE]);

    const [plan] = await SubscriptionService.getPlans();

    expect(plan.prix).toBeNull();
    expect(plan.surDevis).toBe(true);
  });
});
