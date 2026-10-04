'use strict';

/**
 * Tests — le parcours « Premium sur devis » (cahier des charges du client,
 * 04/10/2026).
 *
 * La règle que tout le reste sert :
 *
 *   « Ne pas programmer : le client clique sur payer → Premium actif.
 *     Programmer : devis accepté → session de paiement → paiement traité par
 *     le prestataire → webhook vérifié par le backend → paiement enregistré →
 *     abonnement activé → droits appliqués. »
 *
 * Ce qui est verrouillé ici :
 *
 *   1. le client DEMANDE, il ne chiffre pas — aucun champ de montant
 *      n'existe dans le schéma de demande ;
 *   2. un devis ne s'accepte que chiffré, envoyé et valide ;
 *   3. le paiement exige un devis ACCEPTÉ, non périmé, non déjà réglé ;
 *   4. la session de paiement porte le montant de la BASE, et n'active rien :
 *      souscription `en_attente`, limites et durée du devis figées ;
 *   5. le devis n'est marqué réglé qu'à l'activation, c'est-à-dire par le
 *      webhook ;
 *   6. les limites négociées priment sur celles du catalogue ;
 *   7. une durée libre (18 mois) donne la bonne échéance.
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
  Devis: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), findAndCountAll: jest.fn(), create: jest.fn() },
  Utilisateur: {
    count: jest.fn(), findAll: jest.fn().mockResolvedValue([]), findByPk: jest.fn(),
  },
  Chantier: { count: jest.fn() },
}));

jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(),
}));

jest.mock('../modules/subscription/service/recuPaiement.service.js', () => ({
  emettre: jest.fn().mockResolvedValue(),
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendDevisEmail: jest.fn().mockResolvedValue(),
}));

const sequelizeReel = require('../config/db.js');

const {
  Organisation, PlanAbonnement, AbonnementSouscrit, EvenementPaiement, Devis,
} = require('../models/index.js');

process.env.STRIPE_SECRET_KEY = 'sk_test_pour_les_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pour_les_tests';
process.env.FRONTEND_URL = 'https://app.widjila.test';

const { sendDevisEmail } = require('../infrastructure/emailService.js');
const DevisService = require('../modules/subscription/service/devis.service.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');
const DroitsService = require('../modules/subscription/service/droits.service.js');
const { demanderDevisSchema, preparerDevisSchema } = require('../modules/subscription/validation/devis.validation.js');

const ORG = 'org-1';
const USER = 'user-1';
const ADMIN = 'admin-1';

const PREMIUM = {
  id: 'plan-premium', code: 'entreprise', nom: 'Entreprise', prix: null,
  devise: 'EUR', periode: 'mois', actif: true, ordre: 30,
  limite_utilisateurs: null, limite_chantiers: null, fonctionnalites: ['reserves', 'api'],
};

const organisation = (extra = {}) => ({
  id: ORG, nom: 'Widjila BTP', email: 'contact@example.com', telephone: '0600000000',
  siret: '12345678901234', stripe_customer_id: 'cus_123', trial_ends_at: null, is_subscribed: false,
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

/** Devis en base, dont `update` applique réellement les valeurs. */
const devis = (extra = {}) => {
  const d = {
    id: 'dev-1', organisationId: ORG, numero: 'WDJ-2026-0001', statut: 'envoye',
    planAbonnementId: PREMIUM.id, plan_code: 'entreprise', plan_nom: 'Entreprise',
    montant_ht: '6500.00', taux_tva: '20.00', montant_tva: '1300.00', montant_ttc: '7800.00',
    devise: 'EUR', duree_mois: 12, limite_utilisateurs: 25, limite_chantiers: null,
    options: null, conditions: null, demande: {}, demande_par: USER,
    envoye_le: new Date('2026-10-01'), accepte_le: null, refuse_le: null,
    expire_le: new Date(Date.now() + 15 * 86400000), paye_le: null,
    souscriptionId: null, createdAt: new Date('2026-10-01'),
    ...extra,
  };
  d.update = jest.fn(async (v) => Object.assign(d, v));
  d.get = () => ({ ...d });
  return d;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(sequelizeReel, 'transaction').mockImplementation(async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  jest.spyOn(sequelizeReel, 'query').mockResolvedValue([{ max: 0 }]);
  mockStripe.checkout.sessions.create.mockResolvedValue({
    id: 'cs_test_devis', url: 'https://checkout.stripe.com/c/pay/cs_test_devis',
  });
  AbonnementSouscrit.create.mockResolvedValue({ id: 'sous-1' });
  AbonnementSouscrit.update.mockResolvedValue([0]);
  EvenementPaiement.create.mockResolvedValue({ id: 'e1', update: jest.fn().mockResolvedValue() });
  Organisation.findByPk.mockResolvedValue(organisation());
  PlanAbonnement.findOne.mockResolvedValue(PREMIUM);
});

describe('la demande — le client décrit, il ne chiffre pas', () => {
  it("n'accepte AUCUN champ de montant : le schéma n'en comporte pas", () => {
    const { error } = demanderDevisSchema.validate({
      societe: 'BTP Sénégal', nbUtilisateurs: 25, dureeSouhaitee: 12,
      besoins: 'Multi-agences', montantHt: 1, montantTtc: 1, prix: 1, remise: 90,
    });

    // Joi refuse les clés inconnues : un prix envoyé par le navigateur fait
    // échouer la requête au lieu d'être silencieusement ignoré.
    expect(error).toBeDefined();
    expect(error.message).toMatch(/montantHt/);

    // La même demande, sans prix, passe.
    expect(demanderDevisSchema.validate({
      societe: 'BTP Sénégal', nbUtilisateurs: 25, dureeSouhaitee: 12, besoins: 'Multi-agences',
    }).error).toBeUndefined();
  });

  it('enregistre la demande avec les coordonnées de l’organisation à défaut', async () => {
    Devis.findOne.mockResolvedValue(null);
    Devis.create.mockImplementation(async (v) => ({ ...devis(), ...v, statut: 'brouillon' }));

    const res = await DevisService.demander(ORG, USER, {
      nbUtilisateurs: 25, dureeSouhaitee: 12, besoins: 'Multi-agences',
    });

    expect(res.success).toBe(true);
    const cree = Devis.create.mock.calls[0][0];
    expect(cree).toMatchObject({
      organisationId: ORG, statut: 'brouillon', plan_code: 'entreprise', demande_par: USER,
    });
    expect(cree.numero).toMatch(/^WDJ-\d{4}-0001$/);
    expect(cree.demande).toMatchObject({
      societe: 'Widjila BTP', siren: '12345678901234', email: 'contact@example.com',
      nbUtilisateurs: 25, dureeSouhaitee: 12, besoins: 'Multi-agences',
    });
    // Aucun montant : il n'existe pas encore.
    expect(cree.montant_ht).toBeUndefined();
  });

  it('refuse une seconde demande tant que la première est en cours', async () => {
    Devis.findOne.mockResolvedValue(devis({ statut: 'brouillon' }));

    const res = await DevisService.demander(ORG, USER, {});

    expect(res.success).toBe(false);
    expect(res.code).toBe('DEVIS_DEJA_EN_COURS');
    expect(Devis.create).not.toHaveBeenCalled();
  });

  it('numérote WDJ-<année>-<séquence>, sous verrou', async () => {
    Devis.findOne.mockResolvedValue(null);
    Devis.create.mockImplementation(async (v) => ({ ...devis(), ...v }));
    sequelizeReel.query.mockImplementation(async (sql) => {
      if (sql.includes('advisory')) return [{ verrou: true }];
      return [{ max: 41 }];
    });

    await DevisService.demander(ORG, USER, {});

    expect(Devis.create.mock.calls[0][0].numero).toBe(`WDJ-${new Date().getUTCFullYear()}-0042`);
    const verrou = sequelizeReel.query.mock.calls.find(([sql]) => sql.includes('advisory'));
    expect(verrou[1].replacements.cle).toMatch(/^devis:numero:/);
  });
});

describe('le chiffrage — réservé à l’administration', () => {
  it('calcule la TVA et le TTC à partir du HT : rien ne se saisit deux fois', async () => {
    const d = devis({ statut: 'brouillon', montant_ht: null, montant_ttc: null });
    Devis.findByPk.mockResolvedValue(d);

    const res = await DevisService.preparer('dev-1', ADMIN, {
      montantHt: 6500, tauxTva: 20, dureeMois: 12, limiteUtilisateurs: 25,
    });

    expect(res.success).toBe(true);
    expect(d.montant_ht).toBe(6500);
    expect(d.montant_tva).toBe(1300);
    expect(d.montant_ttc).toBe(7800);
    expect(d.prepare_par).toBe(ADMIN);
    // Une validité est posée d'office : un prix négocié n'engage pas un an.
    expect(d.expire_le).toBeInstanceOf(Date);
  });

  it('le schéma impose montant et durée, et refuse un TTC dicté', () => {
    expect(preparerDevisSchema.validate({ dureeMois: 12 }).error).toBeDefined();
    expect(preparerDevisSchema.validate({ montantHt: 6500 }).error).toBeDefined();
    expect(preparerDevisSchema.validate({ montantHt: 6500, dureeMois: 12, montantTtc: 1 }).error).toBeDefined();
    expect(preparerDevisSchema.validate({ montantHt: 6500, dureeMois: 12 }).error).toBeUndefined();
  });

  it('ne modifie plus un devis accepté : on en établit un nouveau', async () => {
    Devis.findByPk.mockResolvedValue(devis({ statut: 'accepte' }));

    const res = await DevisService.preparer('dev-1', ADMIN, { montantHt: 1, dureeMois: 1 });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/ne se modifie plus/i);
  });

  it('refuse d’envoyer un devis sans montant ni durée', async () => {
    Devis.findByPk.mockResolvedValue(devis({ statut: 'brouillon', montant_ttc: null, duree_mois: null }));

    const res = await DevisService.envoyer('dev-1', ADMIN);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/chiffrez/i);
  });

  it('envoie un devis chiffré et prévient le demandeur', async () => {
    const d = devis({ statut: 'brouillon' });
    Devis.findByPk.mockResolvedValue(d);
    const { notifier } = require('../modules/notification/service/notification.service.js');

    const res = await DevisService.envoyer('dev-1', ADMIN);

    expect(res.success).toBe(true);
    expect(d.statut).toBe('envoye');
    expect(d.envoye_le).toBeInstanceOf(Date);
    expect(notifier).toHaveBeenCalledWith(expect.objectContaining({ utilisateurId: USER, type: 'devis_envoye' }));
  });
});

describe('les courriels — un devis se suit par courriel, pas en rouvrant l’application', () => {
  const { Utilisateur } = require('../models/index.js');

  beforeEach(() => {
    Utilisateur.findAll.mockResolvedValue([
      { id: 'admin-1', email: 'admin@widjila.com' },
      { id: 'admin-2', email: 'support@widjila.com' },
    ]);
    Utilisateur.findByPk.mockResolvedValue({ email: 'compte@example.com' });
  });

  it('à la DEMANDE : alerte les super-admins, et accuse réception au client', async () => {
    Devis.findOne.mockResolvedValue(null);
    Devis.create.mockImplementation(async (v) => ({ ...devis(), ...v, statut: 'brouillon' }));

    await DevisService.demander(ORG, USER, {
      email: 'patron@btp.sn', contact: 'Balla', nbUtilisateurs: 25, besoins: 'Multi-agences',
    });

    expect(sendDevisEmail).toHaveBeenCalledTimes(2);

    // 1. Les super-admins, en UN envoi : la demande doit atteindre celui qui
    //    est disponible, pas le premier de la liste.
    const alerte = sendDevisEmail.mock.calls.find(([a]) => a.variante === 'demande')[0];
    expect(alerte.to).toEqual(['admin@widjila.com', 'support@widjila.com']);
    expect(alerte.demande).toMatchObject({ nbUtilisateurs: 25, besoins: 'Multi-agences' });

    // 2. Le client : sans accusé, il ne sait pas si sa demande est arrivée.
    const accuse = sendDevisEmail.mock.calls.find(([a]) => a.variante === 'accuse')[0];
    expect(accuse.to).toBe('patron@btp.sn');
    expect(accuse.numero).toMatch(/^WDJ-/);
  });

  it('à l’ENVOI : le client reçoit le MONTANT, pas une invitation à se connecter', async () => {
    const d = devis({ statut: 'brouillon', demande: { email: 'patron@btp.sn', contact: 'Balla' } });
    Devis.findByPk.mockResolvedValue(d);

    await DevisService.envoyer('dev-1', ADMIN);

    const envoi = sendDevisEmail.mock.calls.find(([a]) => a.variante === 'pret')[0];
    expect(envoi).toMatchObject({
      to: 'patron@btp.sn',
      numero: 'WDJ-2026-0001',
      montantTtc: '7800 EUR',
      dureeMois: 12,
      limiteUtilisateurs: 25,
    });
    expect(envoi.validiteJusquau).toBeTruthy();
  });

  it('écrit à l’adresse SAISIE dans la demande avant celle du compte', async () => {
    // L'interlocuteur commercial n'est pas toujours le titulaire du compte.
    const d = devis({ statut: 'brouillon', demande: { email: 'achats@btp.sn' } });
    Devis.findByPk.mockResolvedValue(d);

    await DevisService.envoyer('dev-1', ADMIN);

    expect(sendDevisEmail.mock.calls.find(([a]) => a.variante === 'pret')[0].to).toBe('achats@btp.sn');
  });

  it('retombe sur l’adresse du compte, puis sur celle de l’organisation', async () => {
    const d = devis({ statut: 'brouillon', demande: {} });
    Devis.findByPk.mockResolvedValue(d);

    await DevisService.envoyer('dev-1', ADMIN);
    expect(sendDevisEmail.mock.calls.find(([a]) => a.variante === 'pret')[0].to).toBe('compte@example.com');

    jest.clearAllMocks();
    Utilisateur.findByPk.mockResolvedValue(null);
    Organisation.findByPk.mockResolvedValue(organisation());
    const d2 = devis({ statut: 'brouillon', demande: {} });
    Devis.findByPk.mockResolvedValue(d2);

    await DevisService.envoyer('dev-1', ADMIN);
    expect(sendDevisEmail.mock.calls.find(([a]) => a.variante === 'pret')[0].to).toBe('contact@example.com');
  });

  it('un SMTP en panne n’empêche ni l’envoi du devis ni la notification', async () => {
    // Le devis est transmis dans le produit : un courriel perdu ne doit pas
    // annuler un geste commercial déjà accompli.
    sendDevisEmail.mockRejectedValue(new Error('SMTP injoignable'));
    const d = devis({ statut: 'brouillon' });
    Devis.findByPk.mockResolvedValue(d);
    const { notifier } = require('../modules/notification/service/notification.service.js');

    const res = await DevisService.envoyer('dev-1', ADMIN);

    expect(res.success).toBe(true);
    expect(d.statut).toBe('envoye');
    expect(notifier).toHaveBeenCalledWith(expect.objectContaining({ type: 'devis_envoye' }));
  });
});

describe('acceptation et refus', () => {
  it('accepte un devis envoyé et valide', async () => {
    const d = devis();
    Devis.findOne.mockResolvedValue(d);

    const res = await DevisService.accepter(ORG, 'dev-1');

    expect(res.success).toBe(true);
    expect(d.statut).toBe('accepte');
    expect(d.accepte_le).toBeInstanceOf(Date);
  });

  it('refuse d’accepter un devis PÉRIMÉ, et le referme', async () => {
    const d = devis({ expire_le: new Date(Date.now() - 86400000) });
    Devis.findOne.mockResolvedValue(d);

    const res = await DevisService.accepter(ORG, 'dev-1');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/expiré/i);
    expect(d.statut).toBe('expire');
  });

  it('refuse d’accepter un devis encore au brouillon', async () => {
    Devis.findOne.mockResolvedValue(devis({ statut: 'brouillon' }));

    const res = await DevisService.accepter(ORG, 'dev-1');

    expect(res.success).toBe(false);
  });

  it('une acceptation rejouée ne change rien (idempotence)', async () => {
    const d = devis({ statut: 'accepte', accepte_le: new Date('2026-10-02') });
    Devis.findOne.mockResolvedValue(d);

    const res = await DevisService.accepter(ORG, 'dev-1');

    expect(res.success).toBe(true);
    expect(d.update).not.toHaveBeenCalled();
  });

  it('un devis d’une AUTRE organisation est introuvable', async () => {
    Devis.findOne.mockResolvedValue(null);

    const res = await DevisService.obtenir(ORG, 'dev-autre');

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(404);
    // La requête porte toujours l'organisation du jeton.
    expect(Devis.findOne.mock.calls[0][0].where).toMatchObject({ organisationId: ORG });
  });

  it('enregistre le motif d’un refus', async () => {
    const d = devis();
    Devis.findOne.mockResolvedValue(d);

    await DevisService.refuser(ORG, 'dev-1', 'Budget 2027');

    expect(d.statut).toBe('refuse');
    expect(d.motif_refus).toBe('Budget 2027');
  });
});

describe('le paiement du devis', () => {
  it('facture le montant TTC de la BASE et n’active RIEN', async () => {
    const d = devis({ statut: 'accepte', accepte_le: new Date() });
    Devis.findOne.mockResolvedValue(d);
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    const res = await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER);

    expect(res.success).toBe(true);
    expect(res.url).toBe('https://checkout.stripe.com/c/pay/cs_test_devis');

    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.mode).toBe('payment');
    // 7 800 € TTC → 780 000 centimes.
    expect(params.line_items[0].price_data.unit_amount).toBe(780000);
    expect(params.metadata).toMatchObject({ devisId: 'dev-1', devisNumero: 'WDJ-2026-0001' });
    expect(params.success_url).toContain('paiement=retour');

    // Souscription EN ATTENTE, portant les conditions du devis.
    expect(AbonnementSouscrit.create.mock.calls[0][0]).toMatchObject({
      organisationId: ORG, devisId: 'dev-1', statut: 'en_attente',
      prix_paye: 7800, devise: 'EUR', duree_mois: 12,
      limite_utilisateurs: 25, limite_chantiers: null,
      reference_paiement: 'cs_test_devis', activee_par: USER,
    });
    // Le devis n'est PAS réglé : le webhook seul le dira.
    expect(d.paye_le).toBeNull();
  });

  it('refuse de payer un devis non accepté', async () => {
    Devis.findOne.mockResolvedValue(devis({ statut: 'envoye' }));

    const res = await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/acceptez le devis/i);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuse de payer un devis périmé ou déjà réglé', async () => {
    Devis.findOne.mockResolvedValue(devis({ statut: 'accepte', expire_le: new Date(Date.now() - 1000) }));
    expect((await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER)).success).toBe(false);

    jest.clearAllMocks();
    Organisation.findByPk.mockResolvedValue(organisation());
    Devis.findOne.mockResolvedValue(devis({ statut: 'accepte', paye_le: new Date() }));
    const res = await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/déjà été réglé/i);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('recycle la souscription en attente : deux tentatives, un seul contrat', async () => {
    const d = devis({ statut: 'accepte' });
    Devis.findOne.mockResolvedValue(d);
    const enAttente = { id: 'sous-1', update: jest.fn().mockResolvedValue() };
    AbonnementSouscrit.findOne.mockResolvedValue(enAttente);

    await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER);

    expect(AbonnementSouscrit.create).not.toHaveBeenCalled();
    expect(enAttente.update).toHaveBeenCalledWith(expect.objectContaining({
      reference_paiement: 'cs_test_devis', statut: 'en_attente',
    }));
  });

  it('ajoute le virement aux moyens de paiement quand il est configuré', async () => {
    process.env.STRIPE_METHODES_DEVIS = 'card,customer_balance';
    Devis.findOne.mockResolvedValue(devis({ statut: 'accepte' }));
    AbonnementSouscrit.findOne.mockResolvedValue(null);

    await SubscriptionService.creerSessionDevis(ORG, 'dev-1', USER);

    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_method_types)
      .toEqual(['card', 'customer_balance']);
    delete process.env.STRIPE_METHODES_DEVIS;
  });
});

describe('l’activation — par le webhook, jamais par le navigateur', () => {
  const evenement = (type, objet) => {
    mockStripe.webhooks.constructEvent.mockReturnValue({ id: `evt_${type}`, type, data: { object: objet } });
    return SubscriptionService.handleWebhook('{}', 'sig');
  };

  /** Souscription en attente née du devis. */
  const souscription = (extra = {}) => {
    const s = {
      id: 'sous-1', organisationId: ORG, devisId: 'dev-1',
      plan_code: 'entreprise', plan_nom: 'Entreprise',
      prix_paye: '7800.00', devise: 'EUR', periode: 'an', duree_mois: 12,
      limite_utilisateurs: 25, limite_chantiers: null,
      statut: 'en_attente', fournisseur: 'stripe', reference_paiement: 'cs_test_devis',
      ...extra,
    };
    s.update = jest.fn(async (v) => Object.assign(s, v));
    s.get = () => ({ ...s });
    return s;
  };

  it('la session payée active l’abonnement aux conditions du devis, et le marque réglé', async () => {
    const s = souscription();
    const d = devis({ statut: 'accepte' });
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => (
      where.reference_paiement === 'cs_test_devis' ? s : null
    ));
    AbonnementSouscrit.findByPk.mockResolvedValue(s);
    Devis.findByPk.mockResolvedValue(d);

    const res = await evenement('checkout.session.completed', {
      id: 'cs_test_devis', customer: 'cus_123', payment_status: 'paid',
      amount_total: 780000, currency: 'eur',
    });

    expect(res.success).toBe(true);
    expect(s.statut).toBe('active');
    expect(s.date_fin).toBeInstanceOf(Date);
    // 12 mois pleins à partir du début, pas une période de catalogue.
    const mois = (s.date_fin.getUTCFullYear() - s.date_debut.getUTCFullYear()) * 12
      + (s.date_fin.getUTCMonth() - s.date_debut.getUTCMonth());
    expect(mois).toBe(12);
    // Et le devis est réglé.
    expect(d.paye_le).toBeInstanceOf(Date);
    expect(d.souscriptionId).toBe('sous-1');
  });

  it('un montant encaissé différent du devis n’active RIEN', async () => {
    const s = souscription();
    AbonnementSouscrit.findOne.mockResolvedValue(s);
    const d = devis({ statut: 'accepte' });
    Devis.findByPk.mockResolvedValue(d);

    await evenement('checkout.session.completed', {
      id: 'cs_test_devis', customer: 'cus_123', payment_status: 'paid',
      amount_total: 100, currency: 'eur',
    });

    expect(s.statut).toBe('en_attente');
    expect(d.paye_le).toBeNull();
  });

  it('une durée NÉGOCIÉE de 18 mois donne la bonne échéance', async () => {
    const s = souscription({ duree_mois: 18 });
    AbonnementSouscrit.findOne.mockImplementation(async ({ where }) => (
      where.reference_paiement === 'cs_test_devis' ? s : null
    ));
    AbonnementSouscrit.findByPk.mockResolvedValue(s);
    Devis.findByPk.mockResolvedValue(devis({ statut: 'accepte' }));

    await evenement('checkout.session.completed', {
      id: 'cs_test_devis', customer: 'cus_123', payment_status: 'paid',
      amount_total: 780000, currency: 'eur',
    });

    const mois = (s.date_fin.getUTCFullYear() - s.date_debut.getUTCFullYear()) * 12
      + (s.date_fin.getUTCMonth() - s.date_debut.getUTCMonth());
    expect(mois).toBe(18);
  });

  it('le remboursement clôt l’abonnement', async () => {
    const s = souscription({ statut: 'active', reference_paiement: 'pi_123' });
    AbonnementSouscrit.findOne.mockResolvedValue(s);
    Organisation.findByPk.mockResolvedValue(organisation());

    await evenement('charge.refunded', { id: 'ch_1', payment_intent: 'pi_123' });

    expect(s.statut).toBe('annulee');
  });
});

describe('les droits qui en découlent', () => {
  it('les limites NÉGOCIÉES priment sur celles du catalogue', async () => {
    // Le catalogue dit « illimité », le contrat dit 25 : c'est le contrat.
    Organisation.findByPk.mockResolvedValue(organisation());
    AbonnementSouscrit.findOne.mockResolvedValue({
      id: 'sous-1', organisationId: ORG, statut: 'active',
      plan_code: 'entreprise', plan_nom: 'Entreprise',
      limite_utilisateurs: 25, limite_chantiers: 10,
      date_fin: new Date(Date.now() + 86400000 * 300),
      plan: { ...PREMIUM, limite_utilisateurs: null, limite_chantiers: null },
    });

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('abonnement');
    expect(droits.limiteUtilisateurs).toBe(25);
    expect(droits.limiteChantiers).toBe(10);
  });

  it('sans limite négociée, on lit celles du catalogue', async () => {
    Organisation.findByPk.mockResolvedValue(organisation());
    AbonnementSouscrit.findOne.mockResolvedValue({
      id: 'sous-2', organisationId: ORG, statut: 'active',
      plan_code: 'pro', plan_nom: 'Pro',
      limite_utilisateurs: null, limite_chantiers: null,
      date_fin: new Date(Date.now() + 86400000 * 30),
      plan: { code: 'pro', nom: 'Pro', fonctionnalites: ['reserves'], limite_utilisateurs: 5, limite_chantiers: 20 },
    });

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.limiteUtilisateurs).toBe(5);
    expect(droits.limiteChantiers).toBe(20);
  });
});
