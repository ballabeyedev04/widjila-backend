'use strict';

/**
 * Tests — modules/rapport/service/rapportEnvoi.service.js
 *
 * Envoyer un rapport de réserves, c'est diffuser un document contractuel à des
 * tiers. Une erreur ici ne produit pas un écran cassé : elle envoie les
 * réserves de l'entreprise A à l'entreprise B, ou expose l'annuaire d'un
 * chantier à une autre organisation. Ce qui est verrouillé :
 *
 *   1. CLOISONNEMENT — un rapport d'une autre organisation est introuvable,
 *      même avec son identifiant exact ;
 *   2. DESTINATAIRE — l'entreprise concernée, et elle seule. Jamais « toutes
 *      les entreprises du chantier », jamais un repli sur les clients ;
 *   3. COPIE — les clients du chantier, en `cc` et pas en `to` ;
 *   4. PIÈCE JOINTE — le PDF réellement lu depuis le stockage. Un envoi sans
 *      pièce jointe serait pire qu'un échec : personne ne le remarquerait ;
 *   5. VALIDATION — `preparer` n'envoie RIEN. Le client l'a demandé
 *      explicitement : « ne pas envoyer automatiquement le mail sans
 *      validation de l'utilisateur » ;
 *   6. PAS DE RELAIS OUVERT — `exclure` ne peut que retirer des destinataires,
 *      jamais en ajouter.
 */

const { Readable } = require('node:stream');

const mockRapport = { findByPk: jest.fn() };
const mockPartenaire = { findAll: jest.fn(), findOne: jest.fn() };
const mockReserve = { findAll: jest.fn(), count: jest.fn() };
const mockUtilisateur = { findByPk: jest.fn() };

jest.mock('../models/index.js', () => ({
  Rapport: mockRapport,
  Chantier: 'Chantier',
  Organisation: 'Organisation',
  Partenaire: mockPartenaire,
  Reserve: mockReserve,
  Utilisateur: mockUtilisateur,
}));

const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
}));

const mockSendEmail = jest.fn();
jest.mock('../infrastructure/emailService.js', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

jest.mock('../utils/logger.js', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const RapportEnvoiService = require('../modules/rapport/service/rapportEnvoi.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';
const RAPPORT = '33333333-3333-4333-8333-333333333333';
const AUTEUR = '44444444-4444-4444-8444-444444444444';

/** Un rapport déjà généré, tel que le renverrait Sequelize. */
function rapport(parametres = {}) {
  return {
    id: RAPPORT,
    chantierId: CHANTIER,
    type: 'reserves',
    fichier_url: 'rapports/rapport-reserves-RH.pdf',
    parametres,
    createdAt: new Date('2026-09-09T08:00:00Z'),
    chantier: {
      id: CHANTIER,
      nom: 'Résidence Horizon',
      code: 'RH-2026',
      organisationId: ORG,
      organisation: { id: ORG, nom: 'Widjila BTP' },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRapport.findByPk.mockResolvedValue(rapport());
  mockPartenaire.findAll.mockResolvedValue([]);
  mockPartenaire.findOne.mockResolvedValue(null);
  mockReserve.findAll.mockResolvedValue([]);
  mockReserve.count.mockResolvedValue(0);
  mockUtilisateur.findByPk.mockResolvedValue({
    id: AUTEUR, nom: 'Beye', prenom: 'Balla', email: 'balla@widjila.com',
  });
  mockOuvrirFichier.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF-1.7 faux')]) });
  mockSendEmail.mockResolvedValue({ id: 'msg_1' });
});

/** Les partenaires renvoyés selon la requête — entreprises ou clients. */
function annuaire({ entreprises = [], clients = [] }) {
  mockPartenaire.findAll.mockImplementation(({ where }) => {
    if (where.type === 'client') return Promise.resolve(clients);
    return Promise.resolve(entreprises);
  });
}

// ── 1. Cloisonnement ────────────────────────────────────────────────────────

describe('cloisonnement', () => {
  test('la requête filtre sur l’organisation du chantier', async () => {
    await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    const include = mockRapport.findByPk.mock.calls[0][1].include[0];
    expect(include.where).toEqual({ organisationId: ORG });
  });

  test('un rapport d’une autre organisation est introuvable, pas « interdit »', async () => {
    mockRapport.findByPk.mockResolvedValue(null);

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/introuvable/i);
    // Rien ne doit fuir de l'annuaire d'une organisation tierce.
    expect(mockPartenaire.findAll).not.toHaveBeenCalled();
  });

  test('aucun envoi n’est tenté sur un rapport introuvable', async () => {
    mockRapport.findByPk.mockResolvedValue(null);

    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ── 2. Destinataires ────────────────────────────────────────────────────────

describe('destinataires', () => {
  test('un rapport ciblant une entreprise ne s’adresse qu’à elle', async () => {
    const cible = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockRapport.findByPk.mockResolvedValue(rapport({ partenaireId: cible }));
    mockPartenaire.findOne.mockResolvedValue({ id: cible, nom: 'SARL Toiture', email: 'toiture@ex.fr' });
    mockPartenaire.findAll.mockResolvedValue([]); // aucun client

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.envoi.destinataires).toEqual([
      { id: cible, nom: 'SARL Toiture', email: 'toiture@ex.fr' },
    ]);
    // Le partenaire visé est cherché DANS le chantier du rapport : un
    // identifiant d'un autre chantier ne doit pas devenir destinataire.
    expect(mockPartenaire.findOne.mock.calls[0][0].where).toMatchObject({
      id: cible, chantierId: CHANTIER,
    });
  });

  test('sans ciblage, seules les entreprises PORTANT une réserve sont retenues', async () => {
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockReserve.findAll.mockResolvedValue([
      { id: 'r1', partenaireId: a },
      { id: 'r2', partenaireId: a },
      { id: 'r3', partenaireId: null },
    ]);
    annuaire({ entreprises: [{ id: a, nom: 'Toiture', email: 'a@ex.fr' }] });

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    // `b` existe sur le chantier mais ne porte aucune réserve : il n'a rien
    // à recevoir.
    const [{ where }] = mockPartenaire.findAll.mock.calls.find(([o]) => o.where.id);
    const ids = where.id;
    expect(ids).toEqual([a]);
    expect(ids).not.toContain(b);
    expect(r.envoi.destinataires).toHaveLength(1);
  });

  test('le périmètre du rapport filtre les réserves lues', async () => {
    mockRapport.findByPk.mockResolvedValue(rapport({
      statut: 'levee', batimentId: 'bat-1', phaseId: 'ph-1', corpsEtatId: 'ce-1',
    }));

    await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(mockReserve.findAll.mock.calls[0][0].where).toEqual({
      chantierId: CHANTIER,
      statut: 'levee',
      batimentId: 'bat-1',
      phaseId: 'ph-1',
      corpsEtatId: 'ce-1',
    });
  });

  test('le nombre annoncé est compté sur le MÊME périmètre que le PDF', async () => {
    mockRapport.findByPk.mockResolvedValue(rapport({ statut: 'ouverte' }));
    mockReserve.count.mockResolvedValue(7);

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.envoi.nbReserves).toBe(7);
    expect(mockReserve.count.mock.calls[0][0].where).toEqual({
      chantierId: CHANTIER, statut: 'ouverte',
    });
  });

  test('seuls les partenaires de type « client » passent en copie', async () => {
    annuaire({ clients: [{ id: 'c1', nom: 'MOA', email: 'moa@ex.fr' }] });

    await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    const appelClients = mockPartenaire.findAll.mock.calls
      .find(([opts]) => opts.where.type === 'client');
    expect(appelClients[0].where).toEqual({ chantierId: CHANTIER, type: 'client' });
  });
});

// ── 3. Composition du courriel ──────────────────────────────────────────────

describe('composition', () => {
  test('l’objet suit exactement le format demandé', async () => {
    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.envoi.objet).toBe('Rapport de chantier – Résidence Horizon – 09/09/2026');
  });

  test('les entreprises sans adresse sont NOMMÉES, pas ignorées', async () => {
    mockReserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);
    annuaire({
      entreprises: [{ id: 'p1', nom: 'Plomberie Diop', email: null }],
      clients: [{ id: 'c1', nom: 'MOA', email: '   ' }],
    });

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.envoi.sansEmail).toEqual(['Plomberie Diop', 'MOA']);
  });

  test('les réponses reviennent à l’auteur, pas à la boîte technique', async () => {
    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(r.envoi.expediteur).toBe('Balla Beye');
    expect(r.envoi.expediteurEmail).toBe('balla@widjila.com');
  });

  test('sans auteur identifié, l’organisation signe le message', async () => {
    mockUtilisateur.findByPk.mockResolvedValue(null);

    const r = await RapportEnvoiService.preparer(RAPPORT, ORG, null);

    expect(r.envoi.expediteur).toBe('Widjila BTP');
    expect(r.envoi.expediteurEmail).toBeNull();
  });

  test('PRÉPARER N’ENVOIE RIEN', async () => {
    annuaire({ entreprises: [{ id: 'p1', nom: 'Toiture', email: 'a@ex.fr' }] });
    mockReserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);

    await RapportEnvoiService.preparer(RAPPORT, ORG, AUTEUR);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockOuvrirFichier).not.toHaveBeenCalled();
  });
});

// ── 4. Envoi ────────────────────────────────────────────────────────────────

describe('envoi', () => {
  beforeEach(() => {
    mockReserve.findAll.mockResolvedValue([
      { id: 'r1', partenaireId: 'p1' },
      { id: 'r2', partenaireId: 'p2' },
    ]);
    annuaire({
      entreprises: [
        { id: 'p1', nom: 'Toiture', email: 'toiture@ex.fr' },
        { id: 'p2', nom: 'Plomberie', email: 'Plomberie@EX.fr' },
      ],
      clients: [
        { id: 'c1', nom: 'MOA', email: 'moa@ex.fr' },
        { id: 'c2', nom: 'AMO', email: 'amo@ex.fr' },
      ],
    });
  });

  test('entreprises en destinataire, clients en copie, PDF joint', async () => {
    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(true);
    const envoi = mockSendEmail.mock.calls[0][0];
    expect(envoi.to).toEqual(['toiture@ex.fr', 'Plomberie@EX.fr']);
    expect(envoi.cc).toEqual(['moa@ex.fr', 'amo@ex.fr']);
    expect(envoi.replyTo).toBe('balla@widjila.com');
    expect(envoi.subject).toBe('Rapport de chantier – Résidence Horizon – 09/09/2026');
    expect(envoi.attachments).toHaveLength(1);
    expect(envoi.attachments[0].filename).toBe('rapport-RH-2026.pdf');
    expect(envoi.attachments[0].content.toString()).toBe('%PDF-1.7 faux');
  });

  test('le PDF joint est CELUI qui a été généré, relu depuis le stockage', async () => {
    await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(mockOuvrirFichier).toHaveBeenCalledWith('rapports/rapport-reserves-RH.pdf');
  });

  test('une adresse à la fois entreprise et client ne part pas en double', async () => {
    annuaire({
      entreprises: [{ id: 'p1', nom: 'Toiture', email: 'meme@ex.fr' }],
      clients: [{ id: 'c1', nom: 'MOA', email: 'MEME@ex.fr' }],
    });
    mockReserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);

    await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    const envoi = mockSendEmail.mock.calls[0][0];
    expect(envoi.to).toEqual(['meme@ex.fr']);
    expect(envoi.cc).toEqual([]);
  });

  test('`exclure` RETIRE un destinataire choisi par l’utilisateur', async () => {
    await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR, { exclure: ['plomberie@ex.fr'] });

    const envoi = mockSendEmail.mock.calls[0][0];
    expect(envoi.to).toEqual(['toiture@ex.fr']);
  });

  test('`exclure` N’AJOUTE JAMAIS une adresse — pas de relais ouvert', async () => {
    await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR, { exclure: ['pirate@ailleurs.net'] });

    const envoi = mockSendEmail.mock.calls[0][0];
    expect([...envoi.to, ...envoi.cc]).not.toContain('pirate@ailleurs.net');
    expect(envoi.to).toEqual(['toiture@ex.fr', 'Plomberie@EX.fr']);
  });

  test('sans adresse d’entreprise, on REFUSE en nommant les manquantes', async () => {
    annuaire({
      entreprises: [{ id: 'p1', nom: 'Toiture', email: null }],
      clients: [{ id: 'c1', nom: 'MOA', email: 'moa@ex.fr' }],
    });
    mockReserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);

    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toContain('Toiture');
    // Surtout PAS de repli sur les clients : le rapport s'adresse à
    // l'entreprise qui doit lever les réserves.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('aucune entreprise rattachée : message explicite, pas d’envoi', async () => {
    mockReserve.findAll.mockResolvedValue([]);
    annuaire({ clients: [{ id: 'c1', nom: 'MOA', email: 'moa@ex.fr' }] });

    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/aucune entreprise/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('un PDF illisible fait ÉCHOUER l’envoi — jamais de mail sans pièce jointe', async () => {
    mockOuvrirFichier.mockRejectedValue(new Error('ENOENT'));

    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/introuvable/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('un échec du service de messagerie remonte en clair, sans lever', async () => {
    mockSendEmail.mockRejectedValue(new Error('Resend 422'));

    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/échoué/i);
    // Le détail technique reste au journal : il ne dit rien à l'utilisateur.
    expect(r.message).not.toContain('Resend');
  });

  test('le compte rendu dit qui a reçu quoi', async () => {
    const r = await RapportEnvoiService.envoyer(RAPPORT, ORG, AUTEUR);

    expect(r.message).toContain('2 entreprise(s)');
    expect(r.message).toContain('2 client(s) en copie');
    expect(r.envoi.to).toHaveLength(2);
  });
});
