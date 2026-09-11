'use strict';

/**
 * Tests — le partage par lien sécurisé (§ 14 du cahier des charges) et le
 * critère du § 23 : « Lien sécurisé : accès contrôlé ».
 *
 * Les six exigences du § 14, une par une :
 *   unique et difficile à deviner · associé au rapport · révocable ·
 *   limité dans le temps · protégé par authentification · accès journalisés.
 */

const crypto = require('crypto');
const { Readable } = require('node:stream');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
  storeFile: jest.fn(),
  deleteFile: jest.fn(),
}));
jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const modeles = require('../models/index.js');
const { reinitialiser, instance } = require('./helpers/modelesRapportMock.js');
// La VRAIE règle de validité du modèle, appliquée aux doubles.
const { prototype: { estValide } } = jest.requireActual('../models/rapportPartage.model.js');
const RapportPartageService = require('../modules/rapport/service/rapportPartage.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const empreinte = (t) => crypto.createHash('sha256').update(t).digest('hex');

let rapport;

const lePartage = (surcharge = {}) => {
  const p = instance({
    id: 'part-1', rapportId: 'rap-1', token_hash: 'x', expire_le: null, revoque_le: null,
    authentification_requise: false, nb_acces: 0, rapport, ...surcharge,
  });
  Object.defineProperty(p, 'estValide', { enumerable: false, value: estValide.bind(p) });
  return p;
};

beforeEach(() => {
  jest.clearAllMocks();
  reinitialiser(modeles);
  delete process.env.RAPPORT_LIEN_BASE;
  process.env.API_PUBLIC_URL = 'https://api.widjila.test/';

  rapport = instance({
    id: 'rap-1', nom: 'Rapport global', fichier_url: '/uploads/rapports/r.pdf',
    chantier: { id: 'ch-1', nom: 'Résidence', organisationId: ORG },
  });
  modeles.Rapport.findOne.mockImplementation(async ({ include }) => (
    include?.[0]?.where?.organisationId === ORG ? rapport : null
  ));
  modeles.RapportPartage.create.mockImplementation(async (v) => lePartage({ id: 'part-new', ...v }));
  mockOuvrirFichier.mockResolvedValue({ stream: Readable.from(['%PDF']), taille: 4 });
});

describe('création d’un lien (§ 14)', () => {
  it('unique et difficile à deviner : 256 bits, encodés pour une URL', async () => {
    const a = await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });
    const b = await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });

    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('seule l’EMPREINTE est stockée — jamais le jeton', async () => {
    const r = await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });

    const enregistre = modeles.RapportPartage.create.mock.calls[0][0];
    expect(enregistre.token_hash).toBe(empreinte(r.token));
    expect(JSON.stringify(enregistre)).not.toContain(r.token);
  });

  it('rend l’URL publique, sur l’API par défaut', async () => {
    const r = await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });
    expect(r.url).toBe(`https://api.widjila.test/api/v1/r/${r.token}`);
  });

  it('sert la forme courte « widjila.app/r/{token} » quand elle est configurée', async () => {
    process.env.RAPPORT_LIEN_BASE = 'https://widjila.app/r/';
    const r = await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });
    expect(r.url).toBe(`https://widjila.app/r/${r.token}`);
  });

  it('peut être limité dans le temps et exiger une authentification', async () => {
    const avant = Date.now();
    await RapportPartageService.creer('rap-1', ORG, { id: 'u1' }, { expireDansJours: 7, authentificationRequise: true });

    const { expire_le: expire, authentification_requise: auth } = modeles.RapportPartage.create.mock.calls[0][0];
    expect(auth).toBe(true);
    expect(expire.getTime()).toBeGreaterThanOrEqual(avant + 7 * 86400000 - 1000);
    expect(expire.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86400000 + 1000);
  });

  it('est journalisé', async () => {
    await RapportPartageService.creer('rap-1', ORG, { id: 'u1' });
    expect(modeles.RapportHistorique.create.mock.calls[0][0]).toMatchObject({ rapportId: 'rap-1', action: 'partage', acteurId: 'u1' });
  });

  it('refuse de partager un rapport non généré, ou d’une autre organisation', async () => {
    rapport.fichier_url = null;
    expect((await RapportPartageService.creer('rap-1', ORG, { id: 'u1' })).message).toMatch(/Générez/);

    expect((await RapportPartageService.creer('rap-1', 'autre-org', { id: 'u1' })).message).toMatch(/introuvable/);
  });
});

describe('§ 23 — Lien sécurisé : accès contrôlé', () => {
  it('un jeton valide ouvre le rapport, et l’accès est journalisé', async () => {
    const partage = lePartage();
    modeles.RapportPartage.findOne.mockResolvedValue(partage);

    const r = await RapportPartageService.ouvrir('jeton-clair', { ip: '10.0.0.8', userAgent: 'Mozilla/5.0' });

    expect(r.success).toBe(true);
    expect(r.contentType).toBe('application/pdf');
    // Le jeton est cherché par son EMPREINTE.
    expect(modeles.RapportPartage.findOne.mock.calls[0][0].where).toEqual({ token_hash: empreinte('jeton-clair') });
    expect(partage.nb_acces).toBe(1);
    expect(partage.dernier_acces_le).toBeInstanceOf(Date);
    expect(modeles.RapportHistorique.create.mock.calls[0][0]).toMatchObject({
      rapportId: 'rap-1', action: 'consulte_via_lien', acteurId: null,
      metadata: { partageId: 'part-1', ip: '10.0.0.8', authentifie: false },
    });
  });

  it.each([
    ['inconnu', () => null],
    ['révoqué', () => lePartage({ revoque_le: new Date() })],
    ['expiré', () => lePartage({ expire_le: new Date(Date.now() - 1000) })],
  ])('un jeton %s reçoit le MÊME refus — sans confirmer qu’un document existe', async (_cas, fabrique) => {
    modeles.RapportPartage.findOne.mockResolvedValue(fabrique());

    const r = await RapportPartageService.ouvrir('jeton');

    expect(r).toEqual({ success: false, message: 'Ce lien n’est plus valide.' });
    expect(mockOuvrirFichier).not.toHaveBeenCalled();
    expect(modeles.RapportHistorique.create).not.toHaveBeenCalled();
  });

  it('un lien PROTÉGÉ exige un compte de l’organisation propriétaire', async () => {
    modeles.RapportPartage.findOne.mockResolvedValue(lePartage({ authentification_requise: true }));

    const anonyme = await RapportPartageService.ouvrir('jeton');
    expect(anonyme).toMatchObject({ success: false, authentificationRequise: true });

    const etranger = await RapportPartageService.ouvrir('jeton', { utilisateur: { id: 'x', organisationId: 'autre', role: 'ChefProjet' } });
    expect(etranger.success).toBe(false);

    const membre = await RapportPartageService.ouvrir('jeton', { utilisateur: { id: 'u2', organisationId: ORG, role: 'Entreprise' } });
    expect(membre.success).toBe(true);
  });
});

describe('révocation (§ 14)', () => {
  it('révoque immédiatement, une seule fois, et le journalise', async () => {
    const partage = lePartage();
    modeles.RapportPartage.findOne.mockResolvedValue(partage);

    await RapportPartageService.revoquer('rap-1', 'part-1', ORG, { id: 'u1' });
    await RapportPartageService.revoquer('rap-1', 'part-1', ORG, { id: 'u1' });

    expect(partage.revoque_le).toBeInstanceOf(Date);
    expect(partage.estValide()).toBe(false);
    const revocations = modeles.RapportHistorique.create.mock.calls.filter(([l]) => l.action === 'partage_revoque');
    expect(revocations).toHaveLength(1);
  });

  it('un lien d’un autre rapport est introuvable', async () => {
    modeles.RapportPartage.findOne.mockResolvedValue(null);
    const r = await RapportPartageService.revoquer('rap-1', 'part-x', ORG, { id: 'u1' });
    expect(r.success).toBe(false);
  });

  it('la liste dit quels liens sont encore actifs', async () => {
    modeles.RapportPartage.findAll.mockResolvedValue([
      lePartage({ id: 'a' }),
      lePartage({ id: 'b', revoque_le: new Date() }),
    ]);

    const r = await RapportPartageService.lister('rap-1', ORG);

    expect(r.partages.map((p) => [p.id, p.actif])).toEqual([['a', true], ['b', false]]);
  });
});
