'use strict';

/**
 * Tests — audit de sécurité : abonnement et paiement.
 *
 *  1. checkSubscription : un seul mois payé n'ouvre plus l'accès indéfiniment
 *     (`is_subscribed` n'est jamais remis à faux quand `date_fin` passe) ; les
 *     routes partenaires n'échappent plus au mur de fin d'essai.
 *  2. IPN PayTech : organisation et formule tirées de la SEULE donnée signée
 *     (`ref_command`), montant signé contrôlé, méthode « SHA256 des clés »
 *     refusée, idempotence sur `ref_command` et non sur le `token` non signé.
 */

process.env.PAYTECH_API_KEY = 'cle_audit';
process.env.PAYTECH_API_SECRET = 'secret_audit';
process.env.PAYTECH_ENV = 'prod';

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn() },
  AbonnementSouscrit: { count: jest.fn() },
  PlanAbonnement: { findOne: jest.fn() },
}));
jest.mock('../modules/subscription/service/droits.service.js', () => ({
  souscriptionActive: jest.fn(),
}));
jest.mock('../modules/subscription/service/subscription.service.js', () => ({
  traiterEvenement: jest.fn(),
}));

const crypto = require('crypto');
const { Organisation, AbonnementSouscrit, PlanAbonnement } = require('../models/index.js');
const DroitsService = require('../modules/subscription/service/droits.service.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');
const checkSubscription = require('../middlewares/checkSubscription.middleware.js');
const PayTech = require('../modules/paytech/service/paytech.service.js');

const ORG = '11111111-2222-4333-8444-555555555555';
const AUTRE_ORG = '99999999-8888-4777-8666-555555555555';
const JOUR = 24 * 60 * 60 * 1000;

beforeEach(() => jest.clearAllMocks());

describe('checkSubscription — ne ferme plus la porte', () => {
  // Ce garde-barrière était le mur de fin d'essai. Depuis que l'offre
  // gratuite est permanente (src/config/offreGratuite.js), aucun état ne
  // justifie plus de refuser : une organisation sans souscription garde un
  // chantier, deux utilisateurs et des réserves illimitées.
  //
  // Ce qu'il reste à vérifier, c'est qu'il ne refuse RIEN et qu'il renseigne
  // correctement le contexte — les plafonds de volume, eux, sont la
  // responsabilité de `verifierLimite` (requireFonctionnalite.middleware.js).
  const executer = (organisation, path = '/chantiers') => {
    Organisation.findByPk.mockResolvedValue(organisation);
    const req = { user: { role: 'Entreprise', organisationId: ORG }, path };
    return new Promise((resolve) => checkSubscription(req, {}, resolve))
      .then((err) => ({ err, req }));
  };
  const essaiFini = { id: ORG, trial_ends_at: new Date(Date.now() - JOUR), is_subscribed: true };

  it('laisse passer une organisation dont toutes les souscriptions sont échues', async () => {
    // C'est le cas qui répondait « Votre période d'essai est terminée ».
    DroitsService.souscriptionActive.mockResolvedValue(null);
    AbonnementSouscrit.count.mockResolvedValue(1);

    const { err, req } = await executer({ ...essaiFini, is_subscribed: false });

    expect(err).toBeUndefined();
    expect(req.subscription.trialEnded).toBe(true);
  });

  it('laisse passer une souscription en vigueur', async () => {
    DroitsService.souscriptionActive.mockResolvedValue({ id: 's1' });
    const { err } = await executer(essaiFini);
    expect(err).toBeUndefined();
  });

  it('laisse passer un essai encore en cours', async () => {
    const { err, req } = await executer({
      id: ORG, trial_ends_at: new Date(Date.now() + JOUR), is_subscribed: false,
    });
    expect(err).toBeUndefined();
    expect(req.subscription.trialEnded).toBe(false);
  });

  it('les routes partenaires reçoivent le contexte comme les autres', async () => {
    // Elles échappaient autrefois au mur par un chemin d'exemption trop
    // large. Plus de mur, mais elles ne doivent pas redevenir un angle mort.
    const { err, req } = await executer(
      { id: ORG, trial_ends_at: new Date(Date.now() - JOUR), is_subscribed: false },
      '/organisation/partenaires'
    );
    expect(err).toBeUndefined();
    expect(req.subscription).toBeDefined();
  });

  it("ne lit plus l'historique des souscriptions pour décider", async () => {
    // Deux requêtes par appel servaient à trancher un refus qui n'existe
    // plus. Les laisser serait payer pour une décision qu'on ne prend pas.
    DroitsService.souscriptionActive.mockResolvedValue(null);
    AbonnementSouscrit.count.mockClear();

    await executer(essaiFini);

    expect(AbonnementSouscrit.count).not.toHaveBeenCalled();
    expect(DroitsService.souscriptionActive).not.toHaveBeenCalled();
  });

  it('refuse encore une organisation introuvable', async () => {
    // Ce n'est pas une question d'abonnement : c'est un jeton qui désigne
    // une organisation qui n'existe pas.
    const { err } = await executer(null);
    expect(err).toBeDefined();
  });
});

describe('IPN PayTech — seule la donnée signée fait foi', () => {
  const PRO = { code: 'pro', prix: '89.00', devise: 'EUR', actif: true };
  const MONTANT = Math.round(89 * 655.957);

  const ipn = (surcharges = {}) => {
    const ref = PayTech.generateRefCommand(ORG, 'pro');
    const base = {
      type_event: 'sale_complete',
      ref_command: ref,
      item_price: MONTANT,
      token: 'tok-1',
      hmac_compute: PayTech.computeHmac(MONTANT, ref),
    };
    return { ...base, ...surcharges };
  };

  beforeEach(() => {
    PlanAbonnement.findOne.mockResolvedValue(PRO);
    SubscriptionService.traiterEvenement.mockResolvedValue({ success: true });
  });

  it('active l’organisation et la formule portées par ref_command', async () => {
    const charge = ipn();
    const res = await PayTech.handlePaymentIpn(charge);

    expect(res.success).toBe(true);
    expect(SubscriptionService.traiterEvenement).toHaveBeenCalledWith(
      'paytech', charge.ref_command, 'sale_complete',
      expect.objectContaining({ organisationId: ORG, planId: 'pro', reference: charge.ref_command })
    );
  });

  it('IGNORE un custom_field réécrit (non signé) désignant une autre organisation', async () => {
    const faux = Buffer.from(JSON.stringify({ organisationId: AUTRE_ORG, planId: 'entreprise' })).toString('base64');
    await PayTech.handlePaymentIpn(ipn({ custom_field: faux }));

    const [, , , objet] = SubscriptionService.traiterEvenement.mock.calls[0];
    expect(objet.organisationId).toBe(ORG);
    expect(objet.planId).toBe('pro');
  });

  it('rejouée sous un token neuf, la notification garde le MÊME identifiant d’événement', async () => {
    const charge = ipn();
    await PayTech.handlePaymentIpn(charge);
    await PayTech.handlePaymentIpn({ ...charge, token: 'tok-rejoue' });

    const ids = SubscriptionService.traiterEvenement.mock.calls.map((c) => c[1]);
    expect(ids).toEqual([charge.ref_command, charge.ref_command]);
  });

  it('refuse la méthode « SHA256 des clés » (empreintes statiques rejouables)', async () => {
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
    const charge = ipn({ hmac_compute: undefined, api_key_sha256: sha('cle_audit'), api_secret_sha256: sha('secret_audit') });

    const res = await PayTech.handlePaymentIpn(charge);

    expect(res.success).toBe(false);
    expect(SubscriptionService.traiterEvenement).not.toHaveBeenCalled();
  });

  it('refuse un montant signé différent du tarif de la formule', async () => {
    const ref = PayTech.generateRefCommand(ORG, 'pro');
    const res = await PayTech.handlePaymentIpn({
      type_event: 'sale_complete', ref_command: ref, item_price: 100, hmac_compute: PayTech.computeHmac(100, ref),
    });

    expect(res.success).toBe(false);
    expect(SubscriptionService.traiterEvenement).not.toHaveBeenCalled();
  });

  it.each([
    ['désactivée', { ...PRO, actif: false }],
    ['sur devis', { ...PRO, prix: null }],
    ['inconnue', null],
  ])('refuse une formule %s', async (_l, plan) => {
    PlanAbonnement.findOne.mockResolvedValue(plan);
    const res = await PayTech.handlePaymentIpn(ipn());
    expect(res.success).toBe(false);
    expect(SubscriptionService.traiterEvenement).not.toHaveBeenCalled();
  });

  it('refuse une ref_command illisible', async () => {
    const res = await PayTech.handlePaymentIpn({
      type_event: 'sale_complete', ref_command: 'x', item_price: MONTANT, hmac_compute: PayTech.computeHmac(MONTANT, 'x'),
    });
    expect(res.success).toBe(false);
  });

  it('en production, refuse un encaissement de l’environnement de test', async () => {
    const avant = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await PayTech.handlePaymentIpn(ipn({ env: 'test' }));
      expect(res.success).toBe(false);
    } finally {
      process.env.NODE_ENV = avant;
    }
    expect(SubscriptionService.traiterEvenement).not.toHaveBeenCalled();
  });

  it('montantXof : parité fixe EUR→XOF, XOF tel quel, autre devise refusée', () => {
    expect(PayTech.montantXof({ prix: '89.00', devise: 'EUR' })).toBe(MONTANT);
    expect(PayTech.montantXof({ prix: '25000', devise: 'XOF' })).toBe(25000);
    expect(PayTech.montantXof({ prix: '89', devise: 'USD' })).toBeNull();
    expect(PayTech.montantXof({ prix: null, devise: 'EUR' })).toBeNull();
  });
});

describe('Validation PayTech — codes du catalogue', () => {
  const { createPaymentSchema } = require('../modules/paytech/validation/paytech.validation.js');

  it.each(['essentiel', 'pro', 'entreprise'])('accepte le code « %s »', (planId) => {
    expect(createPaymentSchema.validate({ planId }).error).toBeUndefined();
  });

  it('refuse un code qui ne tiendrait pas dans ref_command, ou des caractères parasites', () => {
    expect(createPaymentSchema.validate({ planId: 'x'.repeat(23) }).error).toBeDefined();
    expect(createPaymentSchema.validate({ planId: 'pro_admin' }).error).toBeDefined();
  });

  it('tout code accepté produit une ref_command relisible', () => {
    const ref = PayTech.generateRefCommand(ORG, 'a'.repeat(22));
    expect(PayTech.lireRefCommand(ref)).toEqual({ organisationId: ORG, planCode: 'a'.repeat(22) });
  });
});

describe('Routes PayTech — réservées à la facturation', () => {
  it('pose requireRole sur les trois routes authentifiées', () => {
    const router = require('../modules/paytech/route/paytech.route.js');
    for (const chemin of ['/payment', '/payment/status', '/payment/verify']) {
      const couche = router.stack.find((l) => l.route && l.route.path === chemin);
      // requireRole renvoie une fonction anonyme : on compte les gardes
      // posées entre checkActiveUser et le contrôleur.
      const noms = couche.route.stack.map((s) => s.handle.name);
      const iActif = noms.indexOf('checkActiveUser');
      expect(iActif).toBeGreaterThanOrEqual(0);
      expect(couche.route.stack.length).toBeGreaterThan(iActif + 2);
    }
  });
});
