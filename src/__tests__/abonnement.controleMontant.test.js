'use strict';

/**
 * Tests — le montant encaissé doit correspondre à la formule activée.
 *
 * ## Pourquoi ce contrôle existe
 *
 * La `PaymentIntent` est créée côté serveur à partir de
 * `plans_abonnement.prix` : un client ne peut donc pas choisir son prix. Mais
 * entre la création et l'encaissement, la ligne de catalogue peut avoir été
 * modifiée par un administrateur, ou la souscription rattachée à une autre
 * référence. Activer sur la seule foi de l'identifiant reviendrait à ouvrir
 * une formule sans vérifier qu'elle a été payée.
 *
 * On confronte donc ce que STRIPE dit avoir encaissé au prix figé dans la
 * souscription. En cas d'écart, on n'active pas : un abonnement à ouvrir à la
 * main coûte moins cher qu'une formule accordée sans son prix.
 */

jest.mock('../models/index.js', () => ({
  AbonnementSouscrit: { findOne: jest.fn(), findByPk: jest.fn(), update: jest.fn().mockResolvedValue([0]) },
  PlanAbonnement: { findOne: jest.fn(), findAll: jest.fn() },
  Organisation: { findByPk: jest.fn(), update: jest.fn() },
  EvenementPaiement: { create: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

const { AbonnementSouscrit } = require('../models/index.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

const REFERENCE = 'pi_test_123';

/** Souscription en attente, à 49 € — soit 4900 centimes. */
const enAttente = (surcharges = {}) => ({
  id: 'sous-1',
  organisationId: 'org-1',
  plan_code: 'essentiel',
  prix_paye: '49.00',
  devise: 'EUR',
  periode: 'mois',
  statut: 'en_attente',
  update: jest.fn().mockResolvedValue(undefined),
  ...surcharges,
});

const sequelizeReel = require('../config/db.js');

describe('_activerDepuisPaiement — contrôle du montant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Transaction jouée sans base ; la relecture sous verrou rend la même ligne.
    jest.spyOn(sequelizeReel, 'transaction').mockImplementation(async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
    AbonnementSouscrit.findByPk.mockImplementation((...args) => AbonnementSouscrit.findOne(...args));
  });

  it('une devise SANS décimale (XOF) se compare en unités, pas en centimes', async () => {
    // 32 800 XOF encaissés valent 32 800, pas 3 280 000 : le ×100 aurait fait
    // facturer cent fois le prix — et valider l'écart.
    const souscription = enAttente({ prix_paye: '32800', devise: 'XOF' });
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', { montantRecu: 32800, devise: 'xof' });

    expect(souscription.update).toHaveBeenCalledTimes(1);
  });

  it('active quand le montant encaissé correspond au prix de la formule', async () => {
    const souscription = enAttente();
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4900,
      devise: 'eur',
    });

    expect(souscription.update).toHaveBeenCalledTimes(1);
    expect(souscription.update.mock.calls[0][0].statut).toBe('active');
  });

  it('REFUSE d’activer quand le montant encaissé diffère', async () => {
    // Le cas qui compte : 49 € encaissés pour une formule passée à 89 €, ou
    // l'inverse. Ouvrir la formule reviendrait à l'offrir.
    const souscription = enAttente({ prix_paye: '89.00' });
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4900,
      devise: 'eur',
    });

    expect(souscription.update).not.toHaveBeenCalled();
  });

  it('REFUSE d’activer quand la devise diffère', async () => {
    // 49 EUR et 49 USD ne sont pas le même paiement.
    const souscription = enAttente();
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4900,
      devise: 'usd',
    });

    expect(souscription.update).not.toHaveBeenCalled();
  });

  it('REFUSE d’activer une souscription sans prix exploitable', async () => {
    // Une formule « sur devis » n'est pas souscriptible en ligne. Si une telle
    // ligne arrive jusqu'ici, quelque chose ne va pas : on n'active pas.
    const souscription = enAttente({ prix_paye: null });
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4900,
      devise: 'eur',
    });

    expect(souscription.update).not.toHaveBeenCalled();
  });

  it('tolère les centimes : 49,90 € encaissés valent 4990', async () => {
    const souscription = enAttente({ prix_paye: '49.90' });
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4990,
      devise: 'eur',
    });

    expect(souscription.update).toHaveBeenCalledTimes(1);
  });

  it('n’active pas deux fois la même souscription', async () => {
    // Stripe réémet tant qu'il n'a pas reçu de 2xx.
    const souscription = enAttente({ statut: 'active' });
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);

    await SubscriptionService._activerDepuisPaiement(REFERENCE, 'cus_1', {
      montantRecu: 4900, devise: 'eur',
    });

    expect(souscription.update).not.toHaveBeenCalled();
  });

  it('reste silencieux sur une référence inconnue', async () => {
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    await expect(
      SubscriptionService._activerDepuisPaiement('pi_inconnu', 'cus_1', {
        montantRecu: 4900, devise: 'eur',
      })
    ).resolves.toBeUndefined();
  });
});
