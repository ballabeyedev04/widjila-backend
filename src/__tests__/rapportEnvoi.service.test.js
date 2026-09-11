'use strict';

/**
 * Tests — la diffusion d'un rapport par e-mail (§ 13 du cahier des charges),
 * et les critères du § 23 : « E-mail : bon destinataire et bon fichier/lien »
 * et « Historique : génération et envoi journalisés ».
 *
 * Envoyer un rapport de réserves, c'est diffuser un document contractuel à
 * des tiers. Une erreur ici ne produit pas un écran cassé : elle envoie les
 * réserves de l'entreprise A à l'entreprise B. Ce qui est verrouillé :
 *
 *   1. CLOISONNEMENT — le rapport d'une autre organisation est introuvable ;
 *   2. DESTINATAIRE — l'entreprise concernée, et elle seule ; pour un rapport
 *      par entreprise (§ 15), son seul responsable ;
 *   3. VALIDATION — `preparer` n'envoie RIEN ;
 *   4. PAS DE RELAIS OUVERT — seules les adresses du chantier sont acceptées ;
 *   5. PIÈCE JOINTE OU LIEN — selon le poids du fichier ;
 *   6. TRAÇABILITÉ — qui a reçu quoi, et l'état ENVOYÉ.
 */

const { Readable } = require('node:stream');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
  storeFile: jest.fn(),
  deleteFile: jest.fn(),
}));

const mockSendEmail = jest.fn();
jest.mock('../infrastructure/emailService.js', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const modeles = require('../models/index.js');
const { reinitialiser, instance } = require('./helpers/modelesRapportMock.js');
const RapportEnvoiService = require('../modules/rapport/service/rapportEnvoi.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';
const AUTEUR = 'u-auteur';

const TOITURE = { id: 'p1', nom: 'SARL Toiture', email: 'toiture@ex.fr', type: 'sous_traitant' };
const PLOMBERIE = { id: 'p2', nom: 'Plomberie Diop', email: 'Plomberie@EX.fr', type: 'sous_traitant' };
const MOA = { id: 'c1', nom: 'MOA', email: 'moa@ex.fr', type: 'client' };

let rapport;
let entreprises;
let clients;

function nouveauRapport(surcharge = {}) {
  return instance({
    id: 'rap-1',
    chantierId: CHANTIER,
    nom: 'Rapport global',
    statut: 'genere',
    fichier_url: '/uploads/rapports/rapport-global.pdf',
    taille_pdf: 250 * 1024,
    nb_reserves: 12,
    filtres: {},
    genere_le: new Date('2026-09-09T08:00:00Z'),
    chantier: {
      id: CHANTIER, nom: 'Résidence Horizon', code: 'RH-2026', organisationId: ORG,
      organisation: { id: ORG, nom: 'Widjila BTP' },
    },
    ...surcharge,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  reinitialiser(modeles);
  delete process.env.RAPPORT_LIEN_BASE;
  process.env.API_PUBLIC_URL = 'https://api.widjila.test';

  rapport = nouveauRapport();
  entreprises = [TOITURE, PLOMBERIE];
  clients = [MOA];

  modeles.Rapport.findOne.mockImplementation(async ({ include }) => (
    include?.[0]?.where?.organisationId === ORG ? rapport : null
  ));
  modeles.Reserve.findAll.mockResolvedValue([
    { id: 'r1', partenaireId: 'p1' }, { id: 'r2', partenaireId: 'p2' }, { id: 'r3', partenaireId: null },
  ]);
  modeles.Partenaire.findAll.mockImplementation(async ({ where }) => {
    if (where.type === 'client') return clients;
    if (where.id) return entreprises;
    return [...entreprises, ...clients]; // l'annuaire complet : les candidats
  });
  modeles.ChantierMembre.findAll.mockResolvedValue([
    { utilisateur: { id: 'u-cond', prenom: 'Awa', nom: 'Diop', email: 'awa@widjila.com', role: 'ConducteurTravaux' } },
  ]);
  modeles.Utilisateur.findByPk.mockResolvedValue({ id: AUTEUR, prenom: 'Balla', nom: 'Beye', email: 'balla@widjila.com' });

  mockOuvrirFichier.mockImplementation(async () => ({ stream: Readable.from([Buffer.from('%PDF-1.7 rapport')]) }));
  mockSendEmail.mockResolvedValue({ id: 'msg_1' });
});

const envoiEnvoye = () => mockSendEmail.mock.calls[0][0];
const actionsJournalisees = () => modeles.RapportHistorique.create.mock.calls.map(([l]) => l.action);

describe('cloisonnement', () => {
  it('la lecture filtre sur l’organisation du chantier', async () => {
    await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);
    const include = modeles.Rapport.findOne.mock.calls[0][0].include[0];
    expect(include.where).toEqual({ organisationId: ORG });
  });

  it('un rapport d’une autre organisation est introuvable, et rien ne part', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', 'autre-org', AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/introuvable/i);
    expect(modeles.Partenaire.findAll).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('§ 13 — Widjila PROPOSE les destinataires, l’objet et le message', () => {
  it('propose les entreprises concernées en destinataires, les clients en copie', async () => {
    const { envoi } = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);

    expect(envoi.destinataires.map((d) => d.nom)).toEqual(['SARL Toiture', 'Plomberie Diop']);
    expect(envoi.copies.map((c) => c.email)).toEqual(['moa@ex.fr']);
    expect(envoi.objet).toBe('Rapport de chantier – Résidence Horizon – 09/09/2026');
    expect(envoi.message).toContain('12 réserve(s)');
  });

  it('les candidats sont l’annuaire du chantier ET ses membres — rien d’autre', async () => {
    const { envoi } = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);
    expect(envoi.candidats.map((c) => c.email)).toEqual([
      'toiture@ex.fr', 'Plomberie@EX.fr', 'moa@ex.fr', 'awa@widjila.com',
    ]);
  });

  it('seules les entreprises PORTANT une réserve du périmètre sont proposées', async () => {
    await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);

    const appel = modeles.Partenaire.findAll.mock.calls.find(([o]) => o.where.id);
    expect(appel[0].where.id).toEqual(['p1', 'p2']);
  });

  it('§ 15 — un rapport PAR ENTREPRISE ne propose que son responsable', async () => {
    rapport = nouveauRapport({ partenaireId: 'p1' });
    modeles.Partenaire.findOne.mockResolvedValue(TOITURE);

    const { envoi } = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);

    expect(envoi.destinataires).toEqual([{ id: 'p1', nom: 'SARL Toiture', email: 'toiture@ex.fr' }]);
    // Cherché DANS le chantier : un identifiant d'un autre chantier ne doit pas
    // devenir destinataire.
    expect(modeles.Partenaire.findOne.mock.calls[0][0].where).toMatchObject({ id: 'p1', chantierId: CHANTIER });
  });

  it('un petit rapport part en PIÈCE JOINTE, un rapport lourd en LIEN', async () => {
    const leger = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);
    expect(leger.envoi.mode).toBe('piece_jointe');

    rapport = nouveauRapport({ taille_pdf: 12 * 1024 * 1024 });
    const lourd = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);
    expect(lourd.envoi.mode).toBe('lien');
  });

  it('NOMME les partenaires sans adresse, sans les ignorer', async () => {
    entreprises = [{ id: 'p9', nom: 'Électricité Fall', email: null }];
    clients = [{ id: 'c2', nom: 'AMO', email: '  ' }];

    const { envoi } = await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);
    expect(envoi.sansEmail).toEqual(['Électricité Fall', 'AMO']);
  });

  it('PRÉPARER N’ENVOIE RIEN', async () => {
    await RapportEnvoiService.preparer('rap-1', ORG, AUTEUR);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockOuvrirFichier).not.toHaveBeenCalled();
    expect(modeles.RapportDestinataire.bulkCreate).not.toHaveBeenCalled();
  });
});

describe('§ 23 — E-mail : bon destinataire et bon fichier', () => {
  it('entreprises en destinataire, clients en copie, le PDF GÉNÉRÉ en pièce jointe', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(true);
    const envoi = envoiEnvoye();
    expect(envoi.to).toEqual(['toiture@ex.fr', 'Plomberie@EX.fr']);
    expect(envoi.cc).toEqual(['moa@ex.fr']);
    expect(envoi.replyTo).toBe('balla@widjila.com');
    expect(envoi.attachments).toHaveLength(1);
    expect(envoi.attachments[0].content.toString()).toBe('%PDF-1.7 rapport');
    // Le fichier est celui qui a été produit, relu depuis le stockage.
    expect(mockOuvrirFichier).toHaveBeenCalledWith('/uploads/rapports/rapport-global.pdf');
  });

  it('un rapport lourd part en LIEN SÉCURISÉ, sans pièce jointe', async () => {
    rapport = nouveauRapport({ taille_pdf: 12 * 1024 * 1024 });

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(true);
    const envoi = envoiEnvoye();
    expect(envoi.attachments).toBeUndefined();
    expect(envoi.html).toContain('https://api.widjila.test/api/v1/r/');
    expect(modeles.RapportPartage.create).toHaveBeenCalledTimes(1);
    expect(r.message).toMatch(/lien sécurisé/);
  });

  it('l’utilisateur peut forcer le lien sur un petit rapport', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { mode: 'lien' });
    expect(envoiEnvoye().attachments).toBeUndefined();
  });

  it('l’objet et le message saisis remplacent ceux proposés', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, {
      objet: 'OPR bâtiment A — réserves à lever',
      message: 'Merci de lever avant vendredi.',
    });

    expect(envoiEnvoye().subject).toBe('OPR bâtiment A — réserves à lever');
    expect(envoiEnvoye().html).toContain('Merci de lever avant vendredi.');
  });

  it('le message saisi est échappé : il finit dans du HTML', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { message: '<script>alert(1)</script>' });
    expect(envoiEnvoye().html).not.toContain('<script>');
  });
});

describe('§ 21 — validation des destinataires', () => {
  it('l’utilisateur choisit PARMI les candidats du chantier', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, {
      destinataires: ['awa@widjila.com'], copies: [],
    });

    expect(r.success).toBe(true);
    expect(envoiEnvoye().to).toEqual(['awa@widjila.com']);
    expect(envoiEnvoye().cc).toEqual([]);
  });

  it('une adresse étrangère au chantier est REFUSÉE en la nommant', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, {
      destinataires: ['toiture@ex.fr', 'pirate@ailleurs.net'],
    });

    expect(r.success).toBe(false);
    expect(r.message).toContain('pirate@ailleurs.net');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('`exclure` retire, et n’ajoute jamais', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { exclure: ['plomberie@ex.fr', 'pirate@ailleurs.net'] });

    expect(envoiEnvoye().to).toEqual(['toiture@ex.fr']);
    expect([...envoiEnvoye().to, ...envoiEnvoye().cc]).not.toContain('pirate@ailleurs.net');
  });

  it('une même adresse en destinataire et en copie ne part qu’une fois', async () => {
    entreprises = [{ id: 'p1', nom: 'Toiture', email: 'meme@ex.fr' }];
    clients = [{ id: 'c1', nom: 'MOA', email: 'MEME@ex.fr' }];
    modeles.Reserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);

    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(envoiEnvoye().to).toEqual(['meme@ex.fr']);
    expect(envoiEnvoye().cc).toEqual([]);
  });

  it('sans adresse d’entreprise, on REFUSE — jamais de repli sur les clients', async () => {
    entreprises = [{ id: 'p1', nom: 'Toiture', email: null }];
    modeles.Reserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toContain('Toiture');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('un rapport non généré ne s’envoie pas', async () => {
    rapport = nouveauRapport({ fichier_url: null, statut: 'brouillon' });

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Générez le rapport/);
  });
});

describe('§ 23 — Historique : l’envoi est journalisé', () => {
  it('trace chaque destinataire (REPORT_RECIPIENT) et passe le rapport à ENVOYÉ', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    const lignes = modeles.RapportDestinataire.bulkCreate.mock.calls[0][0];
    expect(lignes.map((l) => [l.email, l.role, l.statut_envoi, l.mode])).toEqual([
      ['toiture@ex.fr', 'to', 'envoye', 'piece_jointe'],
      ['Plomberie@EX.fr', 'to', 'envoye', 'piece_jointe'],
      ['moa@ex.fr', 'cc', 'envoye', 'piece_jointe'],
    ]);
    expect(lignes[0]).toMatchObject({ partenaireId: 'p1', nom: 'SARL Toiture' });
    expect(lignes[0].envoye_le).toBeInstanceOf(Date);

    expect(rapport.statut).toBe('envoye');
    const historique = modeles.RapportHistorique.create.mock.calls.map(([l]) => l).find((l) => l.action === 'envoye');
    expect(historique.metadata).toMatchObject({ to: ['toiture@ex.fr', 'Plomberie@EX.fr'], cc: ['moa@ex.fr'], mode: 'piece_jointe' });
  });

  it('un échec du service de messagerie est tracé, et dit en clair', async () => {
    mockSendEmail.mockRejectedValue(new Error('Resend 422'));

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/échoué/);
    expect(r.message).not.toContain('Resend');
    expect(modeles.RapportDestinataire.bulkCreate.mock.calls[0][0][0].statut_envoi).toBe('echec');
    expect(actionsJournalisees()).toContain('echec');
    expect(rapport.statut).toBe('genere'); // rien n'a été diffusé
  });

  it('un PDF illisible fait échouer l’envoi — jamais de mail sans pièce jointe', async () => {
    mockOuvrirFichier.mockRejectedValue(new Error('ENOENT'));

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/introuvable/);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
