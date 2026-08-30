'use strict';

/**
 * Tests — administration du catalogue et encaissements externes.
 *
 * Ce qui est verrouillé :
 *   1. une formule DÉJÀ SOUSCRITE ne se supprime pas — l'historique y renvoie ;
 *   2. le CODE n'est pas modifiable : il sert de clé dans l'historique ;
 *   3. un code de fonctionnalité inconnu est écarté, pas enregistré ;
 *   4. changer un prix ne touche AUCUNE souscription passée ;
 *   5. PayTech facture le prix de la BASE, jamais le montant qu'il annonce.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn(), findOne: jest.fn() },
  PlanAbonnement: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  AbonnementSouscrit: {
    findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(),
    create: jest.fn(), update: jest.fn(), count: jest.fn(),
  },
  EvenementPaiement: { create: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

const {
  Organisation, PlanAbonnement, AbonnementSouscrit,
} = require('../models/index.js');

process.env.STRIPE_SECRET_KEY = 'sk_test_pour_les_tests';

const PlanAbonnementService = require('../modules/subscription/service/planAbonnement.service.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');

const ORG = 'org-1';

const planLigne = (extra = {}) => ({
  id: 'plan-pro', code: 'pro', nom: 'Pro', description: 'desc',
  prix: '89.00', devise: 'EUR', periode: 'mois', actif: true,
  limite_utilisateurs: 5, limite_chantiers: null,
  fonctionnalites: ['reserves'], ordre: 20,
  stripe_price_id: null,
  createdAt: new Date(), updatedAt: new Date(),
  update: jest.fn().mockResolvedValue(),
  destroy: jest.fn().mockResolvedValue(),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  AbonnementSouscrit.count.mockResolvedValue(0);
  AbonnementSouscrit.update.mockResolvedValue([0]);
  AbonnementSouscrit.create.mockResolvedValue({ id: 's1', organisationId: ORG, statut: 'active' });
  AbonnementSouscrit.findOne.mockResolvedValue(null);
});

describe('suppression d’une formule', () => {
  it('REFUSE dès qu’une souscription y renvoie, et dit combien', async () => {
    // La supprimer effacerait le lien avec des transactions réelles.
    PlanAbonnement.findByPk.mockResolvedValue(planLigne());
    AbonnementSouscrit.count.mockResolvedValue(7);

    const res = await PlanAbonnementService.supprimer('plan-pro');

    expect(res.success).toBe(false);
    expect(res.message).toContain('7 souscriptions');
    expect(res.message).toMatch(/désactivez/i);
  });

  it('accorde le singulier sur une seule souscription', async () => {
    PlanAbonnement.findByPk.mockResolvedValue(planLigne());
    AbonnementSouscrit.count.mockResolvedValue(1);

    const res = await PlanAbonnementService.supprimer('plan-pro');
    expect(res.message).toMatch(/^1 souscription utilise/);
  });

  it('supprime quand aucune souscription n’y renvoie', async () => {
    const plan = planLigne();
    PlanAbonnement.findByPk.mockResolvedValue(plan);

    const res = await PlanAbonnementService.supprimer('plan-pro');

    expect(res.success).toBe(true);
    expect(plan.destroy).toHaveBeenCalled();
  });
});

describe('modification d’une formule', () => {
  it('ne touche à AUCUNE souscription passée', async () => {
    // `prix_paye` est figé dans l'historique : changer le tarif du catalogue
    // ne réécrit pas ce qui a été encaissé.
    const plan = planLigne();
    PlanAbonnement.findByPk.mockResolvedValue(plan);

    await PlanAbonnementService.modifier('plan-pro', { prix: 99 });

    expect(plan.update).toHaveBeenCalledWith({ prix: 99 });
    expect(AbonnementSouscrit.update).not.toHaveBeenCalled();
  });

  it('écarte les codes de fonctionnalité inconnus', async () => {
    // Les laisser entrer donnerait l'illusion, dans l'administration, d'avoir
    // accordé une option qui n'existe pas.
    const plan = planLigne();
    PlanAbonnement.findByPk.mockResolvedValue(plan);

    await PlanAbonnementService.modifier('plan-pro', {
      fonctionnalites: ['rapports', 'option_inventee', 'api'],
    });

    expect(plan.update).toHaveBeenCalledWith({ fonctionnalites: ['rapports', 'api'] });
  });

  it('efface le prix en NULL, pas en zéro', async () => {
    // « Sur devis » et « gratuit » ne sont pas la même offre.
    const plan = planLigne();
    PlanAbonnement.findByPk.mockResolvedValue(plan);

    await PlanAbonnementService.modifier('plan-pro', { prix: null });

    expect(plan.update).toHaveBeenCalledWith({ prix: null });
  });

  it('désactiver ne touche à aucune souscription en cours', async () => {
    const plan = planLigne();
    PlanAbonnement.findByPk.mockResolvedValue(plan);

    await PlanAbonnementService.basculerActif('plan-pro', false);

    expect(plan.update).toHaveBeenCalledWith({ actif: false });
    expect(AbonnementSouscrit.update).not.toHaveBeenCalled();
  });
});

describe('encaissement externe (PayTech)', () => {
  const objetIpn = {
    organisationId: ORG, planId: 'pro', reference: 'tok_123',
    fournisseur: 'paytech', montantRecu: 89,
  };

  it('facture le prix de la BASE, pas le montant annoncé', async () => {
    // Un montant transmis par le fournisseur reste une donnée entrante :
    // on ne facture pas sur parole.
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(planLigne());

    await SubscriptionService.enregistrerPaiementExterne({ ...objetIpn, montantRecu: 1 });

    const creee = AbonnementSouscrit.create.mock.calls[0][0];
    expect(creee.prix_paye).toBe(89);
  });

  it('signale l’écart entre le montant annoncé et le tarif', async () => {
    // L'écart doit être VISIBLE, pas silencieusement écrasé.
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(planLigne());

    await SubscriptionService.enregistrerPaiementExterne({ ...objetIpn, montantRecu: 1 });

    expect(AbonnementSouscrit.create.mock.calls[0][0].note).toMatch(/différent du tarif/i);
  });

  it('ne note rien quand le montant correspond', async () => {
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(planLigne());

    await SubscriptionService.enregistrerPaiementExterne(objetIpn);

    expect(AbonnementSouscrit.create.mock.calls[0][0].note).toBeNull();
  });

  it('active la souscription et met fin aux précédentes', async () => {
    // Sans cela, deux lignes resteraient actives et le service des droits en
    // choisirait une au hasard.
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(planLigne());

    await SubscriptionService.enregistrerPaiementExterne(objetIpn);

    expect(AbonnementSouscrit.update).toHaveBeenCalledWith(
      { statut: 'expiree' },
      { where: { organisationId: ORG, statut: 'active' } }
    );
    expect(AbonnementSouscrit.create.mock.calls[0][0].statut).toBe('active');
  });

  it('ne recrée rien si la référence est déjà connue', async () => {
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(planLigne());
    AbonnementSouscrit.findOne.mockResolvedValue({ id: 'deja' });

    await SubscriptionService.enregistrerPaiementExterne(objetIpn);

    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
  });

  it('ignore un encaissement dont la formule est introuvable', async () => {
    // Mieux vaut ne rien activer que d'activer une formule devinée.
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });
    PlanAbonnement.findOne.mockResolvedValue(null);

    await SubscriptionService.enregistrerPaiementExterne(objetIpn);

    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
  });

  it('ignore un encaissement sans organisation', async () => {
    await SubscriptionService.enregistrerPaiementExterne({ ...objetIpn, organisationId: null });
    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
  });
});

describe('annulation', () => {
  it('n’efface pas l’historique : la souscription passe en « annulee »', async () => {
    const souscription = {
      id: 's1', organisationId: ORG, statut: 'active',
      update: jest.fn().mockResolvedValue(),
    };
    AbonnementSouscrit.findOne.mockResolvedValue(souscription);
    Organisation.findByPk.mockResolvedValue({ id: ORG, update: jest.fn().mockResolvedValue() });

    const res = await SubscriptionService.annulerAbonnement(ORG);

    expect(res.success).toBe(true);
    expect(souscription.update).toHaveBeenCalledWith({ statut: 'annulee' });
  });

  it('refuse proprement quand il n’y a rien à annuler', async () => {
    AbonnementSouscrit.findOne.mockResolvedValue(null);
    const res = await SubscriptionService.annulerAbonnement(ORG);
    expect(res.success).toBe(false);
  });
});
