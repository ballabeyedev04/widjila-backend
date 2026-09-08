'use strict';

/**
 * Tests — le reçu de paiement.
 *
 * ## Le manque
 *
 * L'application enregistrait la souscription et l'affichait dans l'historique,
 * mais n'envoyait RIEN au payeur. Or ce sont des entreprises : elles ont besoin
 * d'une pièce pour leur comptabilité, et la réclamer au support à chaque
 * règlement coûte des deux côtés.
 *
 * ## Ce que ces tests verrouillent
 *
 * 1. Le PDF se génère et porte les bonnes informations — formule, montant,
 *    payeur, période.
 * 2. Il est archivé sur le stockage AVANT d'être envoyé, et son URL est
 *    conservée : l'historique doit pouvoir le reproposer des mois plus tard
 *    sans le régénérer, donc sans risque qu'il diffère du document remis.
 * 3. Le destinataire est celui qui a PAYÉ, l'adresse de l'organisation ne
 *    servant que de repli.
 * 4. RIEN de tout cela ne peut faire échouer l'activation d'un abonnement déjà
 *    encaissé. C'est la garantie la plus importante du fichier.
 */

jest.mock('../models/index.js', () => ({
  AbonnementSouscrit: {},
  Organisation: { findByPk: jest.fn() },
  Utilisateur: { findByPk: jest.fn() },
}));

jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: jest.fn(),
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendRecuPaiementEmail: jest.fn(),
}));

const { Organisation, Utilisateur } = require('../models/index.js');
const { storeFile } = require('../infrastructure/storage.service.js');
const { sendRecuPaiementEmail } = require('../infrastructure/emailService.js');
const RecuPaiementService = require('../modules/subscription/service/recuPaiement.service.js');
const { genererPdf, numeroRecu } = require('../modules/subscription/service/recuPaiement.service.js');

const ORG = { id: 'org-1', nom: 'Sotraco BTP', email: 'compta@sotraco.sn', adresse: 'Route de Ngor', ville: 'Dakar' };
const PAYEUR = { id: 'u-1', prenom: 'Balla', nom: 'Beye', email: 'balla@sotraco.sn' };

/** Une souscription activée, telle que le webhook la voit. */
const souscription = (extra = {}) => ({
  id: '9f8e7d6c-5b4a-4321-9876-abcdef123456',
  organisationId: ORG.id,
  activee_par: PAYEUR.id,
  plan_code: 'PRO',
  plan_nom: 'Pro',
  prix_paye: 49,
  devise: 'EUR',
  periode: 'mensuel',
  fournisseur: 'stripe',
  reference_paiement: 'pi_3QxSample',
  date_debut: new Date('2026-09-07'),
  date_fin: new Date('2026-10-07'),
  update: jest.fn().mockResolvedValue(true),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  Organisation.findByPk.mockResolvedValue(ORG);
  Utilisateur.findByPk.mockResolvedValue(PAYEUR);
  storeFile.mockResolvedValue('/uploads/recus/recu-WJ-202609-123456.pdf');
  sendRecuPaiementEmail.mockResolvedValue(true);
});

describe('le document', () => {
  it('est un PDF valide', async () => {
    const pdf = await genererPdf({ souscription: souscription(), organisation: ORG, payeur: PAYEUR });

    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('reste léger — il part en pièce jointe à CHAQUE paiement', async () => {
    // Le logo d'origine pesait 300 Ko et se retrouvait tel quel dans chaque
    // reçu. Réduit une fois pour toutes, il n'alourdit plus les envois.
    const pdf = await genererPdf({ souscription: souscription(), organisation: ORG, payeur: PAYEUR });

    expect(pdf.length).toBeLessThan(120 * 1024);
  });

  it('se génère même sans payeur ni organisation connus', async () => {
    // Un paiement importé, une organisation supprimée : le reçu ne doit pas
    // faire tomber le webhook pour autant.
    const pdf = await genererPdf({ souscription: souscription(), organisation: null, payeur: null });

    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });
});

describe('le numéro de reçu', () => {
  it('est lisible et se relie à la souscription', () => {
    // Année, mois, et la fin de l'identifiant : on retrouve la ligne en base à
    // partir du papier.
    expect(numeroRecu(souscription())).toBe('WJ-202609-123456');
  });

  it('diffère pour deux souscriptions distinctes', () => {
    const a = numeroRecu(souscription());
    const b = numeroRecu(souscription({ id: '11111111-2222-3333-4444-555555555555' }));

    expect(a).not.toBe(b);
  });

  it('reste calculable sans date de début', () => {
    expect(numeroRecu(souscription({ date_debut: null }))).toMatch(/^WJ-\d{6}-[0-9A-F]{6}$/);
  });
});

describe('émission', () => {
  it('archive le reçu PUIS l’envoie', async () => {
    const s = souscription();

    await RecuPaiementService.emettre(s);

    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(sendRecuPaiementEmail).toHaveBeenCalledTimes(1);
    // L'ordre compte : un reçu envoyé mais introuvable ensuite dans
    // l'historique serait plus gênant qu'un reçu archivé qu'on peut renvoyer.
    expect(storeFile.mock.invocationCallOrder[0])
      .toBeLessThan(sendRecuPaiementEmail.mock.invocationCallOrder[0]);
  });

  it('range le fichier dans le dossier des reçus', async () => {
    await RecuPaiementService.emettre(souscription());

    const [buffer, nom, dossier] = storeFile.mock.calls[0];
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(nom).toMatch(/^recu-WJ-\d{6}-[0-9A-F]{6}\.pdf$/);
    expect(dossier).toBe('recus');
  });

  it('conserve l’URL sur la souscription', async () => {
    // C'est elle qui permettra de reproposer le MÊME document plus tard.
    const s = souscription();

    await RecuPaiementService.emettre(s);

    expect(s.update).toHaveBeenCalledWith({
      recu_url: '/uploads/recus/recu-WJ-202609-123456.pdf',
    });
  });

  it('écrit à celui qui a PAYÉ', async () => {
    await RecuPaiementService.emettre(souscription());

    const charge = sendRecuPaiementEmail.mock.calls[0][0];
    expect(charge.to).toBe(PAYEUR.email);
    expect(charge.planNom).toBe('Pro');
    expect(charge.montant).toContain('49,00');
    expect(charge.pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('retombe sur l’adresse de l’organisation quand le payeur est inconnu', async () => {
    // Mieux vaut le service comptable que personne.
    Utilisateur.findByPk.mockResolvedValue(null);

    await RecuPaiementService.emettre(souscription({ activee_par: null }));

    expect(sendRecuPaiementEmail.mock.calls[0][0].to).toBe(ORG.email);
  });

  it('n’envoie rien — sans échouer — quand aucune adresse n’existe', async () => {
    Utilisateur.findByPk.mockResolvedValue(null);
    Organisation.findByPk.mockResolvedValue({ ...ORG, email: null });

    const url = await RecuPaiementService.emettre(souscription({ activee_par: null }));

    expect(url).toBeNull();
    expect(sendRecuPaiementEmail).not.toHaveBeenCalled();
  });
});

describe('rien ne peut faire échouer un paiement déjà encaissé', () => {
  // La garantie la plus importante : l'abonnement est actif, et le reste du
  // parcours ne doit pas dépendre d'un PDF.

  it('avale une panne du stockage', async () => {
    storeFile.mockRejectedValue(new Error('R2 indisponible'));

    await expect(RecuPaiementService.emettre(souscription())).resolves.toBeNull();
  });

  it('avale une panne du service d’envoi', async () => {
    sendRecuPaiementEmail.mockRejectedValue(new Error('Resend indisponible'));

    await expect(RecuPaiementService.emettre(souscription())).resolves.toBeNull();
  });

  it('avale une organisation introuvable', async () => {
    Organisation.findByPk.mockRejectedValue(new Error('base indisponible'));

    await expect(RecuPaiementService.emettre(souscription())).resolves.toBeNull();
  });
});
