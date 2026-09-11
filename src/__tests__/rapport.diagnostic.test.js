'use strict';

/**
 * Tests — le diagnostic de la génération, par l'ANCIEN point d'entrée.
 *
 * ## Le défaut d'origine
 *
 * « Erreur interne du serveur ». Rien d'autre. La génération enchaîne des
 * étapes qui échouent pour des raisons SANS RAPPORT entre elles — lire les
 * données, composer le PDF, écrire le fichier — et toutes remontaient le même
 * message. L'utilisateur ne savait pas quoi corriger, le journal ne disait
 * pas où chercher.
 *
 * ## Ce qui est verrouillé ici
 *
 *   1. L'ANCIEN ÉCRAN FONCTIONNE TOUJOURS : il passe désormais par le service
 *      Rapports du cahier des charges, et reçoit le nouveau document ;
 *   2. CHAQUE ÉTAPE EST NOMMÉE, avec un message lisible ;
 *   3. LE JOURNAL PORTE LE CONTEXTE et la trace technique ;
 *   4. UN SCHÉMA EN RETARD EST DIT COMME TEL ;
 *   5. LES PHOTOS NE BLOQUENT PAS ;
 *   6. LE CONTRÔLEUR REND UN 400 pour une étape nommée, pas un 500.
 */

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockStoreFile = jest.fn();
const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: (...a) => mockStoreFile(...a),
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
  deleteFile: jest.fn().mockResolvedValue(),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../utils/logger.js', () => mockLogger);

const modeles = require('../models/index.js');
const { reinitialiser, instance } = require('./helpers/modelesRapportMock.js');
const RapportService = require('../modules/rapport/service/rapport.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';

const chantier = {
  id: CHANTIER, nom: 'Résidence Horizon', code: 'RH-2026',
  organisationId: ORG, organisation: { id: ORG, nom: 'Widjila BTP', logo_url: null },
};

let base;
/** Rend l'enregistrement final (statut « genere ») impossible, pour un test. */
let enregistrementCasse;

beforeEach(() => {
  jest.clearAllMocks();
  reinitialiser(modeles);
  base = new Map();
  enregistrementCasse = false;

  modeles.Chantier.findOne.mockImplementation(async ({ where }) => (
    where.id === CHANTIER && where.organisationId === ORG ? chantier : null
  ));
  modeles.Rapport.create.mockImplementation(async (v) => {
    const r = instance({ id: `rap-${base.size + 1}`, createdAt: new Date(), chantier, ...v });
    const miseAJour = r.update;
    Object.defineProperty(r, 'update', {
      enumerable: false,
      value: jest.fn(async (champs) => {
        if (enregistrementCasse && champs.statut === 'genere') throw new Error('contrainte violée');
        return miseAJour(champs);
      }),
    });
    base.set(r.id, r);
    return r;
  });
  modeles.Rapport.findOne.mockImplementation(async ({ where }) => base.get(where.id) || null);
  // Réclamation conditionnelle de la génération : `UPDATE … WHERE id = …`.
  modeles.Rapport.update.mockImplementation(async (champs, { where }) => {
    const r = base.get(where.id);
    if (!r) return [0];
    Object.assign(r, champs);
    return [1];
  });
  mockStoreFile.mockResolvedValue('/uploads/rapports/rapport.pdf');
  mockOuvrirFichier.mockResolvedValue(null);
});

const generer = (params = {}) =>
  RapportService.genererRapport({ chantierId: CHANTIER, type: 'reserves', ...params }, 'u1', ORG);

describe('l’ancien point d’entrée passe par le nouveau service', () => {
  it('produit le PDF, l’enregistre et le trace', async () => {
    const r = await generer();

    expect(r.success).toBe(true);
    expect(mockStoreFile).toHaveBeenCalledTimes(1);
    const [buffer, nom, dossier] = mockStoreFile.mock.calls[0];
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(nom).toBe('rapport-global-rh-2026-v1.pdf');
    expect(dossier).toBe('rapports');
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('[rapport] Généré'));
  });

  it('conserve l’ancien type, que l’ancien écran affiche en libellé', async () => {
    const r = await generer({ type: 'opr' });

    expect(r.rapport.type).toBe('opr');
    expect(r.rapport.modele).toBe('OPR');
    expect(r.rapport.statut).toBe('genere');
  });

  it('« par bâtiment » sans bâtiment retombe sur le global, sans refuser', async () => {
    // L'ancien écran proposait « Tous » : refuser casserait un geste valide
    // pour lui. Le périmètre obtenu est exactement celui d'avant.
    const r = await generer({ type: 'batiment' });

    expect(r.success).toBe(true);
    expect(r.rapport.modele).toBe('GLOBAL');
  });

  it('un chantier d’une autre organisation est introuvable, sans 500', async () => {
    modeles.Chantier.findOne.mockResolvedValue(null);

    expect(await generer()).toEqual({ success: false, message: 'Chantier introuvable' });
    expect(mockStoreFile).not.toHaveBeenCalled();
  });
});

describe('étapes nommées', () => {
  it('lecture des données : l’étape et le contexte partent au journal', async () => {
    modeles.Reserve.findAll.mockRejectedValue(new Error('connexion perdue'));

    await expect(generer()).rejects.toMatchObject({
      etapeRapport: 'lecture-donnees',
      message: expect.stringContaining('Impossible de lire les données'),
    });

    const [ligne, meta] = mockLogger.error.mock.calls[0];
    expect(ligne).toContain('lecture-donnees');
    expect(ligne).toContain(CHANTIER);
    expect(ligne).toContain('connexion perdue');
    expect(meta.stack).toBeDefined();
  });

  it('écriture du fichier : message distinct, taille au journal', async () => {
    mockStoreFile.mockRejectedValue(new Error('ENOSPC'));

    await expect(generer()).rejects.toMatchObject({ etapeRapport: 'stockage' });

    const ligne = mockLogger.error.mock.calls[0][0];
    expect(ligne).toContain('stockage');
    expect(ligne).toContain('taille');
  });

  it('enregistrement en base : le PDF était bon, l’historique a échoué', async () => {
    enregistrementCasse = true;

    await expect(generer()).rejects.toMatchObject({
      etapeRapport: 'enregistrement',
      message: expect.stringContaining('historique'),
    });
  });
});

describe('schéma de base en retard', () => {
  const erreurSql = (code) => {
    const err = new Error('column "x" does not exist');
    err.parent = { code };
    return err;
  };

  test.each([
    ['42P01', 'table inconnue'],
    ['42703', 'colonne inconnue'],
  ])('%s (%s) → migration à appliquer, pas « vérifiez le chantier »', async (code) => {
    modeles.Reserve.findAll.mockRejectedValue(erreurSql(code));

    const echec = await generer().catch((e) => e);

    expect(echec.message).toContain('migration');
    expect(echec.message).not.toContain('Vérifiez le chantier');
  });

  test('une autre erreur SQL garde le message de l’étape', async () => {
    modeles.Reserve.findAll.mockRejectedValue(erreurSql('40001'));

    const echec = await generer().catch((e) => e);

    expect(echec.message).toContain('Impossible de lire les données');
    expect(echec.message).not.toContain('migration');
  });
});

describe('photos indisponibles', () => {
  test('un stockage injoignable produit un rapport SANS images', async () => {
    modeles.Reserve.findAll.mockResolvedValue([{
      id: 'r1', numero: '1', titre: 'Fissure', description: 'Mur nord',
      statut: 'creee', severite: 'haute', createdAt: new Date('2026-09-01'),
      medias: [{ id: 'm1', url: '/uploads/medias/x.jpg', type: 'photo' }],
    }]);
    mockOuvrirFichier.mockRejectedValue(new Error('R2 injoignable'));

    const r = await generer();

    expect(r.success).toBe(true);
    expect(mockStoreFile).toHaveBeenCalledTimes(1);
  });
});

describe('contrôleur', () => {
  const controller = require('../modules/rapport/controller/rapport.controller.js');

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

  const executer = async (handler, req, res) => {
    let capturee = null;
    await handler(req, res, (err) => { capturee = err; });
    return capturee;
  };

  test('une étape nommée devient un 400 PORTEUR du message', async () => {
    modeles.Reserve.findAll.mockRejectedValue(new Error('connexion perdue'));

    const err = await executer(controller.genererRapport, requete(), reponse());

    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Impossible de lire les données');
  });

  test('une erreur INATTENDUE n’est pas déguisée en 400', async () => {
    modeles.Chantier.findOne.mockRejectedValue(new Error('panne inattendue'));

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
