'use strict';

/**
 * Tests — le diagnostic de la génération de rapport.
 *
 * ## Le défaut d'origine
 *
 * « Erreur interne du serveur ». Rien d'autre. La génération enchaîne quatre
 * étapes qui échouent pour des raisons SANS RAPPORT entre elles — lire les
 * données, charger les photos, composer le PDF, écrire le fichier — et toutes
 * remontaient le même message générique. L'utilisateur ne savait pas quoi
 * corriger, et le journal ne disait pas où chercher.
 *
 * ## Ce qui est verrouillé ici
 *
 *   1. CHAQUE ÉTAPE EST NOMMÉE. L'échec porte son étape (`etapeRapport`) et
 *      un message que l'utilisateur peut lire ;
 *   2. LE JOURNAL PORTE LE CONTEXTE — chantier, type, volumes — et la trace
 *      technique. Sans cela, un rapport qui échoue chez un client reste
 *      indiagnosticable à distance ;
 *   3. UN SCHÉMA EN RETARD EST DIT COMME TEL. Une migration non appliquée
 *      n'est pas un problème de chantier : envoyer l'utilisateur « vérifier
 *      le chantier » lui ferait chercher pendant des heures ;
 *   4. LES PHOTOS NE BLOQUENT PAS. Un stockage injoignable produit un rapport
 *      SANS images — pas l'absence de rapport ;
 *   5. LE CONTRÔLEUR REND UN 400, pas un 500 : le serveur a compris la
 *      demande, c'est son exécution qui a échoué pour une raison que
 *      l'appelant peut souvent lever.
 */

const mockFabrique = () => ({
  findAll: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findByPk: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
});

const mockModeles = {
  Rapport: mockFabrique(),
  Chantier: mockFabrique(),
  Reserve: mockFabrique(),
  Inspection: mockFabrique(),
  Organisation: 'Organisation',
  Utilisateur: mockFabrique(),
  ChantierMembre: mockFabrique(),
  Convocation: mockFabrique(),
  Partenaire: mockFabrique(),
  Lot: mockFabrique(),
  Batiment: 'Batiment',
  Etage: 'Etage',
  Zone: 'Zone',
  Plan: 'Plan',
  CorpsEtat: 'CorpsEtat',
  Phase: 'Phase',
  Media: 'Media',
};

jest.mock('../models/index.js', () => mockModeles);

const mockStoreFile = jest.fn();
const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: (...a) => mockStoreFile(...a),
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../utils/logger.js', () => mockLogger);

const RapportService = require('../modules/rapport/service/rapport.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';

/** Le chantier existe et appartient à l'organisation — le cas nominal. */
function chantierTrouve() {
  mockModeles.Chantier.findOne.mockResolvedValue({
    id: CHANTIER, nom: 'Résidence Horizon', code: 'RH-2026',
    organisationId: ORG, organisation: { id: ORG, nom: 'Widjila BTP' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const modele of Object.values(mockModeles)) {
    if (typeof modele !== 'object') continue;
    modele.findAll.mockResolvedValue([]);
    modele.findOne.mockResolvedValue(null);
    modele.findByPk.mockResolvedValue(null);
    modele.count.mockResolvedValue(0);
  }
  chantierTrouve();
  mockModeles.Rapport.create.mockImplementation(async (v) => ({ id: 'rap-1', ...v }));
  mockStoreFile.mockResolvedValue('/uploads/rapports/rapport.pdf');
  mockOuvrirFichier.mockResolvedValue(null);
});

const generer = (params = {}) =>
  RapportService.genererRapport({ chantierId: CHANTIER, type: 'reserves', ...params }, null, ORG);

// ── 1. Le chemin nominal reste intact ───────────────────────────────────────

describe('génération nominale', () => {
  test('produit un PDF, l’enregistre et le trace', async () => {
    const r = await generer();

    expect(r.success).toBe(true);
    expect(mockStoreFile).toHaveBeenCalledTimes(1);
    const [buffer, nom, dossier] = mockStoreFile.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(nom).toBe('rapport-reserves-RH-2026.pdf');
    expect(dossier).toBe('rapports');

    // Le journal doit permettre de constater après coup ce qui a été produit.
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('[rapport] Généré'));
  });

  test('un chantier d’une autre organisation est introuvable, sans 500', async () => {
    mockModeles.Chantier.findOne.mockResolvedValue(null);

    const r = await generer();

    expect(r).toEqual({ success: false, message: 'Chantier introuvable' });
    expect(mockStoreFile).not.toHaveBeenCalled();
  });
});

// ── 2. Chaque étape est nommée ──────────────────────────────────────────────

describe('étapes nommées', () => {
  test('lecture des données : l’étape et le contexte partent au journal', async () => {
    mockModeles.Reserve.findAll.mockRejectedValue(new Error('connexion perdue'));

    await expect(generer()).rejects.toMatchObject({
      etapeRapport: 'lecture-donnees',
      message: expect.stringContaining('Impossible de lire les données'),
    });

    const [ligne, meta] = mockLogger.error.mock.calls[0];
    expect(ligne).toContain('lecture-donnees');
    expect(ligne).toContain(CHANTIER);
    expect(ligne).toContain('connexion perdue');
    // La trace technique aussi : sans elle, on sait QUE ça a cassé, pas OÙ.
    expect(meta.stack).toBeDefined();
  });

  test('écriture du fichier : message distinct de celui de la lecture', async () => {
    mockStoreFile.mockRejectedValue(new Error('ENOSPC'));

    await expect(generer()).rejects.toMatchObject({ etapeRapport: 'stockage' });

    const ligne = mockLogger.error.mock.calls[0][0];
    expect(ligne).toContain('stockage');
    // Le contexte porte la taille : un échec d'écriture se diagnostique avec.
    expect(ligne).toContain('taille');
  });

  test('enregistrement en base : le PDF était bon, l’historique a échoué', async () => {
    mockModeles.Rapport.create.mockRejectedValue(new Error('contrainte violée'));

    await expect(generer()).rejects.toMatchObject({
      etapeRapport: 'enregistrement',
      message: expect.stringContaining('historique'),
    });
  });
});

// ── 3. Un schéma en retard le dit ───────────────────────────────────────────

describe('schéma de base en retard', () => {
  /** Une erreur PostgreSQL telle que Sequelize la remonte. */
  const erreurSql = (code) => {
    const err = new Error(`column "x" does not exist`);
    err.parent = { code };
    return err;
  };

  test.each([
    ['42P01', 'table inconnue'],
    ['42703', 'colonne inconnue'],
  ])('%s (%s) → migration à appliquer, pas « vérifiez le chantier »', async (code) => {
    mockModeles.Reserve.findAll.mockRejectedValue(erreurSql(code));

    const echec = await generer().catch((e) => e);

    expect(echec.message).toContain('migration');
    expect(echec.message).not.toContain('Vérifiez le chantier');
  });

  test('une autre erreur SQL garde le message de l’étape', async () => {
    mockModeles.Reserve.findAll.mockRejectedValue(erreurSql('40001')); // sérialisation

    const echec = await generer().catch((e) => e);

    expect(echec.message).toContain('Impossible de lire les données');
    expect(echec.message).not.toContain('migration');
  });
});

// ── 4. Les photos ne bloquent pas le rapport ────────────────────────────────

describe('photos indisponibles', () => {
  test('un stockage injoignable produit un rapport SANS images', async () => {
    mockModeles.Reserve.findAll.mockResolvedValue([{
      id: 'r1', numero: 1, titre: 'Fissure', description: 'Mur nord',
      statut: 'creee', severite: 'majeure', createdAt: new Date('2026-09-01'),
      medias: [{ id: 'm1', url: '/uploads/medias/x.jpg', type: 'photo' }],
    }]);
    mockOuvrirFichier.mockRejectedValue(new Error('R2 injoignable'));

    const r = await generer();

    // Le rapport SORT — c'est le point. Une réserve sans photo reste une
    // réserve ; pas de rapport du tout, c'est une visite perdue.
    expect(r.success).toBe(true);
    expect(mockStoreFile).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Le contrôleur rend un 400, pas un 500 ────────────────────────────────

describe('contrôleur', () => {
  const controller = require('../modules/rapport/controller/rapport.controller.js');

  /** Une réponse Express réduite à ce que le contrôleur en utilise. */
  const reponse = () => {
    const res = { code: null, corps: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.corps = b; return res; };
    return res;
  };

  const requete = () => ({
    body: { chantierId: CHANTIER },
    query: {},
    user: { id: 'u1', organisationId: ORG, role: 'ChefProjet' },
    params: {},
  });

  /** `asyncHandler` renvoie l'erreur par `next` — on la capture. */
  const executer = async (handler, req, res) => {
    let capturee = null;
    await handler(req, res, (err) => { capturee = err; });
    return capturee;
  };

  test('une étape nommée devient un 400 PORTEUR du message', async () => {
    mockModeles.Reserve.findAll.mockRejectedValue(new Error('connexion perdue'));

    const err = await executer(controller.genererRapport, requete(), reponse());

    // 400 et non 500 : le serveur a compris la demande. Et surtout, le
    // message reste celui de l'étape — c'est tout l'objet du changement.
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Impossible de lire les données');
  });

  test('une erreur INATTENDUE n’est pas déguisée en 400', async () => {
    // Pas d'`etapeRapport` : le contrôleur ne doit pas s'en attribuer la
    // compréhension. Une panne qu'on ne sait pas nommer reste une 500.
    mockModeles.Chantier.findOne.mockRejectedValue(new Error('panne inattendue'));

    const err = await executer(controller.genererRapport, requete(), reponse());

    expect(err.statusCode).toBeUndefined();
    expect(err.message).toBe('panne inattendue');
  });

  test('le succès répond 201 avec le rapport', async () => {
    const res = reponse();
    const err = await executer(controller.genererRapport, requete(), res);

    expect(err).toBeNull();
    expect(res.code).toBe(201);
    expect(res.corps.data.rapport).toBeDefined();
  });
});
