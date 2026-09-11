'use strict';

/**
 * Tests — le service Rapports, de bout en bout (cahier des charges § 11, § 15,
 * § 18, § 19, § 20).
 *
 * Les modèles sont doublés, mais TOUT le reste tourne pour de vrai : filtres,
 * composition du PDF, classeur Excel. Un fichier réellement produit est donc
 * relu pour vérifier ce qu'il contient — c'est la seule façon de prouver le
 * critère le plus important du § 23 : « Rapport par entreprise : un document
 * distinct par société », sans aucune réserve d'une autre.
 */

const { Op } = require('sequelize');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockStoreFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: (...a) => mockStoreFile(...a),
  deleteFile: (...a) => mockDeleteFile(...a),
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../utils/logger.js', () => mockLogger);

const modeles = require('../models/index.js');
const { reinitialiser, instance } = require('./helpers/modelesRapportMock.js');
const RapportsService = require('../modules/rapport/service/rapports.service.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');
const { lireTextePdf, lireTextePdfNormalise } = require('./helpers/lireTextePdf.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';
const BAT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ETRANGER = '99999999-9999-4999-8999-999999999999';
const UTILISATEUR = { id: 'u1', nom: 'Beye', prenom: 'Balla', organisationId: ORG };

const chantier = {
  id: CHANTIER, nom: 'Résidence Les Jardins', code: 'RJ-2026', organisationId: ORG,
  organisation: { id: ORG, nom: 'Widjila BTP', logo_url: null },
};

/** Les rapports « en base » : ce que `findOne` rendra. */
let base;

/** Une réserve telle que Sequelize la rendrait. */
const reserve = (n, surcharge = {}) => ({
  id: `res-${n}`,
  numero: `R-${String(n).padStart(4, '0')}`,
  titre: `Défaut ${n}`,
  statut: 'en_cours',
  severite: 'haute',
  createdAt: new Date('2026-09-01T08:00:00Z'),
  date_limite: '2026-09-15',
  medias: [],
  ...surcharge,
});

const ABC = { id: 'p-abc', nom: 'ABC Carrelage', email: 'abc@ex.fr' };
const XYZ = { id: 'p-xyz', nom: 'XYZ Plomberie', email: 'xyz@ex.fr' };

/** Les réserves du chantier ; `Reserve.findAll` applique le filtre entreprise. */
let reserves;

function enBase(ligne) {
  const r = instance({ chantier, chantierId: CHANTIER, ...ligne });
  base.set(r.id, r);
  return r;
}

function brouillon(surcharge = {}) {
  return enBase({
    id: 'rap-1', type: 'reserves', nom: 'Rapport global', modele: 'GLOBAL', statut: 'brouillon',
    sections: { ...R.SECTIONS_PAR_DEFAUT }, filtres: {}, formats: ['PDF'], version: 1,
    fichier_url: null, fichier_xlsx_url: null, generePar: 'u1', createdAt: new Date(),
    ...surcharge,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  reinitialiser(modeles);
  base = new Map();
  reserves = [
    reserve(1, { partenaireId: ABC.id, partenaire: ABC }),
    reserve(2, { partenaireId: ABC.id, partenaire: ABC }),
    reserve(3, { partenaireId: XYZ.id, partenaire: XYZ }),
    reserve(4, { partenaireId: null }),
  ];

  modeles.Chantier.findOne.mockImplementation(async ({ where }) => (
    where.id === CHANTIER && where.organisationId === ORG ? chantier : null
  ));
  modeles.Rapport.findOne.mockImplementation(async ({ where, include }) => {
    const organisation = include?.[0]?.where?.organisationId;
    if (organisation !== ORG) return null;
    return base.get(where.id) || null;
  });
  modeles.Rapport.create.mockImplementation(async (v) => enBase({ id: `rap-${base.size + 1}`, createdAt: new Date(), ...v }));
  modeles.Reserve.findAll.mockImplementation(async ({ where }) => {
    const entreprises = where.partenaireId?.[Op.in];
    return entreprises ? reserves.filter((r) => entreprises.includes(r.partenaireId)) : reserves;
  });
  modeles.Partenaire.findAll.mockResolvedValue([ABC, XYZ]);

  mockStoreFile.mockImplementation(async (buffer, nom, dossier) => `/uploads/${dossier}/${Date.now()}-${nom}`);
  mockDeleteFile.mockResolvedValue();
  mockOuvrirFichier.mockResolvedValue(null);
});

/** Actions d'historique écrites pour un rapport. */
const actions = (rapportId) => modeles.RapportHistorique.create.mock.calls
  .map(([ligne]) => ligne)
  .filter((l) => l.rapportId === rapportId)
  .map((l) => l.action);

/* ══════════════════════════════════════════════════════════════════════════
   § 9 POST /reports — la configuration
   ══════════════════════════════════════════════════════════════════════════ */

describe('création (§ 11, étape 1)', () => {
  it('crée un BROUILLON sans fichier, avec ses filtres et son historique', async () => {
    const r = await RapportsService.creer({
      chantierId: CHANTIER,
      nom: 'Relance ABC',
      modele: 'ENTREPRISE',
      filtres: { company_id: ABC.id, statuses: ['A_TRAITER', 'EN_COURS'] },
      formats: ['pdf', 'Excel'],
    }, UTILISATEUR, ORG);

    expect(r.success).toBe(true);
    expect(r.rapport).toMatchObject({
      statut: 'brouillon', modele: 'ENTREPRISE', nom: 'Relance ABC', version: 1,
      formats: ['PDF', 'XLSX'], partenaireId: ABC.id,
    });
    expect(r.rapport.fichier_url).toBeUndefined();

    // REPORT_FILTER : une ligne par valeur retenue.
    const lignes = modeles.RapportFiltre.bulkCreate.mock.calls[0][0];
    expect(lignes).toEqual(expect.arrayContaining([
      { rapportId: r.rapport.id, partenaireId: ABC.id },
      { rapportId: r.rapport.id, statut: 'A_TRAITER' },
      { rapportId: r.rapport.id, statut: 'EN_COURS' },
    ]));
    expect(actions(r.rapport.id)).toEqual(['cree']);
  });

  it('un chantier d’une autre organisation est introuvable', async () => {
    const autre = await RapportsService.creer({ chantierId: CHANTIER, modele: 'GLOBAL' }, UTILISATEUR, 'autre-org');

    expect(autre).toEqual({ success: false, message: 'Chantier introuvable' });
    expect(modeles.Rapport.create).not.toHaveBeenCalled();
  });

  it('le SAV est annoncé pour plus tard, pas comme une faute de frappe', async () => {
    const r = await RapportsService.creer({ chantierId: CHANTIER, modele: 'SAV' }, UTILISATEUR, ORG);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/version ultérieure/);
  });

  it('un « rapport par bâtiment » sans bâtiment est refusé', async () => {
    const r = await RapportsService.creer({ chantierId: CHANTIER, modele: 'BATIMENT' }, UTILISATEUR, ORG);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/un bâtiment/);
  });

  it('refuse un étage qui n’appartient pas au chantier (§ 21)', async () => {
    modeles.Batiment.findAll.mockResolvedValue([{ id: BAT_A, nom: 'A', etages: [] }]);

    const r = await RapportsService.creer({
      chantierId: CHANTIER, modele: 'GLOBAL', filtres: { etages: [ETRANGER] },
    }, UTILISATEUR, ORG);

    expect(r.success).toBe(false);
    expect(r.message).toContain(ETRANGER);
    expect(modeles.Rapport.create).not.toHaveBeenCalled();
  });

  it('le modèle « à traiter » enregistre son périmètre par défaut', async () => {
    const r = await RapportsService.creer({ chantierId: CHANTIER, modele: 'A_TRAITER' }, UTILISATEUR, ORG);
    expect(r.rapport.filtres.statuts).toEqual(['A_TRAITER', 'EN_COURS', 'A_CONTROLER']);
  });
});

describe('modification (§ 20)', () => {
  it('réécrit les filtres et journalise la modification', async () => {
    brouillon();

    const r = await RapportsService.modifier('rap-1', { filtres: { statuts: ['LEVEE'] }, nom: 'Levées' }, UTILISATEUR, ORG);

    expect(r.success).toBe(true);
    expect(r.rapport.filtres.statuts).toEqual(['LEVEE']);
    expect(r.rapport.nom).toBe('Levées');
    expect(modeles.RapportFiltre.destroy).toHaveBeenCalledWith({ where: { rapportId: 'rap-1' } });
    expect(actions('rap-1')).toEqual(['modifie']);
  });

  it('refuse de modifier un rapport DÉJÀ DIFFUSÉ (§ 18)', async () => {
    brouillon({ statut: 'envoye', fichier_url: '/uploads/rapports/v1.pdf' });

    const r = await RapportsService.modifier('rap-1', { nom: 'Autre' }, UTILISATEUR, ORG);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/déjà été diffusé/);
    expect(base.get('rap-1').nom).toBe('Rapport global');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 11 — la génération
   ══════════════════════════════════════════════════════════════════════════ */

describe('génération (§ 11)', () => {
  it('produit un VRAI PDF et un VRAI Excel, les stocke en privé et les enregistre', async () => {
    brouillon({ formats: ['PDF', 'XLSX'] });

    const r = await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    expect(r.success).toBe(true);
    expect(mockStoreFile).toHaveBeenCalledTimes(2);
    const [[pdf, nomPdf, dossierPdf], [xlsx, nomXlsx]] = mockStoreFile.mock.calls;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(xlsx.subarray(0, 2).toString()).toBe('PK'); // un .xlsx est une archive ZIP
    expect(nomPdf).toBe('rapport-global-rj-2026-v1.pdf');
    expect(nomXlsx).toBe('rapport-global-rj-2026-v1.xlsx');
    expect(dossierPdf).toBe('rapports');

    const rapport = base.get('rap-1');
    expect(rapport.statut).toBe('genere');
    expect(rapport.fichier_url).toMatch(/\.pdf$/);
    expect(rapport.fichier_xlsx_url).toMatch(/\.xlsx$/);
    expect(rapport.nb_reserves).toBe(4);
    expect(rapport.taille_pdf).toBe(pdf.length);
    expect(rapport.genere_le).toBeInstanceOf(Date);
  });

  it('passe par l’état GÉNÉRATION avant GÉNÉRÉ (§ 19)', async () => {
    brouillon();
    await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    const etats = base.get('rap-1').update.mock.calls.map(([c]) => c.statut).filter(Boolean);
    expect(etats).toEqual(['generation', 'genere']);
  });

  it('journalise la génération (§ 18, § 23)', async () => {
    brouillon();
    await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    const ligne = modeles.RapportHistorique.create.mock.calls.map(([l]) => l).find((l) => l.action === 'genere');
    expect(ligne).toMatchObject({ rapportId: 'rap-1', acteurId: 'u1' });
    expect(ligne.metadata).toMatchObject({ version: 1, reserves: 4, formats: ['PDF'] });
  });

  it('§ 23 — le rapport global contient TOUTES les réserves attendues', async () => {
    brouillon();
    await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    const texte = lireTextePdf(mockStoreFile.mock.calls[0][0]);
    for (const numero of ['R-0001', 'R-0002', 'R-0003', 'R-0004']) expect(texte).toContain(numero);
  });

  it('cloisonne par l’organisation — un identifiant deviné ne sert à rien', async () => {
    brouillon();

    const r = await RapportsService.generer('rap-1', UTILISATEUR, 'autre-org');

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/introuvable/);
    expect(mockStoreFile).not.toHaveBeenCalled();
  });

  it('régénérer un rapport NON diffusé remplace son fichier', async () => {
    brouillon({ statut: 'genere', fichier_url: '/uploads/rapports/ancien.pdf' });

    await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    expect(mockDeleteFile).toHaveBeenCalledWith('/uploads/rapports/ancien.pdf');
    expect(modeles.Rapport.create).not.toHaveBeenCalled();
  });

  it('régénérer un rapport DIFFUSÉ crée une NOUVELLE VERSION et garde l’ancienne (§ 18)', async () => {
    brouillon({ statut: 'envoye', fichier_url: '/uploads/rapports/envoye.pdf', version: 1 });

    const r = await RapportsService.generer('rap-1', UTILISATEUR, ORG);

    expect(r.nouvelleVersion).toBe(true);
    expect(r.rapport.id).not.toBe('rap-1');
    expect(r.rapport).toMatchObject({ version: 2, rapportParentId: 'rap-1', statut: 'genere' });

    const ancien = base.get('rap-1');
    // Le document reçu par l'entreprise reste intact, fichier compris.
    expect(ancien.statut).toBe('archive');
    expect(ancien.fichier_url).toBe('/uploads/rapports/envoye.pdf');
    expect(mockDeleteFile).not.toHaveBeenCalled();

    expect(actions(r.rapport.id)).toContain('nouvelle_version');
    expect(actions('rap-1')).toContain('archive');
  });

  it('un échec est un ÉTAT (§ 19) : motif enregistré et journalisé', async () => {
    brouillon();
    modeles.Reserve.findAll.mockRejectedValue(new Error('connexion perdue'));

    await expect(RapportsService.generer('rap-1', UTILISATEUR, ORG)).rejects.toMatchObject({
      etapeRapport: 'lecture-donnees',
    });

    const rapport = base.get('rap-1');
    expect(rapport.statut).toBe('echec');
    expect(rapport.erreur).toMatch(/Impossible de lire les données/);
    expect(actions('rap-1')).toContain('echec');
  });

  it('un schéma de base en retard est annoncé comme tel', async () => {
    brouillon();
    const err = new Error('relation "rapport_filtres" does not exist');
    err.parent = { code: '42P01' };
    modeles.Reserve.findAll.mockRejectedValue(err);

    const echec = await RapportsService.generer('rap-1', UTILISATEUR, ORG).catch((e) => e);
    expect(echec.message).toMatch(/migration/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 20 — prévisualisation
   ══════════════════════════════════════════════════════════════════════════ */

describe('prévisualisation (§ 20)', () => {
  it('produit le PDF filigrané SANS rien stocker ni changer d’état', async () => {
    brouillon();

    const r = await RapportsService.previsualiser('rap-1', ORG, UTILISATEUR);

    expect(r.success).toBe(true);
    expect(lireTextePdfNormalise(r.buffer)).toContain('PREVISUALISATION');
    expect(mockStoreFile).not.toHaveBeenCalled();
    expect(base.get('rap-1').update).not.toHaveBeenCalled();
    expect(base.get('rap-1').statut).toBe('brouillon');
  });

  it('le résumé chiffré annonce le périmètre sans produire de document', async () => {
    brouillon();

    const r = await RapportsService.resume('rap-1', ORG);

    expect(r.resume.total).toBe(4);
    expect(r.resume.parStatut.EN_COURS).toBe(4);
    expect(mockStoreFile).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 15 — un rapport par entreprise
   ══════════════════════════════════════════════════════════════════════════ */

describe('§ 15 / § 23 — un document distinct par société', () => {
  it('produit un rapport par entreprise, chacun limité à SES réserves', async () => {
    brouillon({ nom: 'Relance' });

    const r = await RapportsService.genererParEntreprise('rap-1', UTILISATEUR, ORG);

    expect(r.success).toBe(true);
    expect(r.rapports).toHaveLength(2);
    expect(r.rapports.map((x) => x.partenaireId)).toEqual([ABC.id, XYZ.id]);
    expect(new Set(r.rapports.map((x) => x.lotGenerationId)).size).toBe(1);
    expect(r.rapports.map((x) => x.nom)).toEqual(['Relance — ABC Carrelage', 'Relance — XYZ Plomberie']);

    // Le cœur du § 15 : aucune réserve d'une autre société dans le document.
    const [pdfAbc, pdfXyz] = mockStoreFile.mock.calls.map(([buffer]) => lireTextePdf(buffer));
    expect(pdfAbc).toContain('R-0001');
    expect(pdfAbc).toContain('R-0002');
    expect(pdfAbc).not.toContain('R-0003');
    expect(pdfXyz).toContain('R-0003');
    expect(pdfXyz).not.toContain('R-0001');
  });

  it('les réserves sans entreprise sont COMPTÉES, pas perdues en silence', async () => {
    brouillon();
    const r = await RapportsService.genererParEntreprise('rap-1', UTILISATEUR, ORG);
    expect(r.reservesSansEntreprise).toBe(1);
  });

  it('sans aucune entreprise rattachée, le dit', async () => {
    brouillon();
    reserves = [reserve(1, { partenaireId: null })];

    const r = await RapportsService.genererParEntreprise('rap-1', UTILISATEUR, ORG);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/sans entreprise/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Duplication, historique, téléchargement
   ══════════════════════════════════════════════════════════════════════════ */

describe('duplication, historique, téléchargement', () => {
  it('la copie repart en BROUILLON, sans fichier, et les deux rapports le tracent', async () => {
    brouillon({ statut: 'envoye', fichier_url: '/uploads/rapports/v1.pdf', version: 3 });

    const r = await RapportsService.dupliquer('rap-1', UTILISATEUR, ORG);

    expect(r.rapport).toMatchObject({ statut: 'brouillon', version: 1, nom: 'Rapport global (copie)' });
    expect(r.rapport.fichier_url).toBeUndefined();
    expect(actions(r.rapport.id)).toEqual(['cree']);
    expect(actions('rap-1')).toEqual(['duplique']);
  });

  it('l’historique se lit dans l’ordre, avec des libellés et des auteurs', async () => {
    brouillon();
    modeles.RapportHistorique.findAll.mockResolvedValue([
      { id: 'h1', action: 'cree', createdAt: new Date('2026-09-10T08:00:00Z'), acteur: { prenom: 'Balla', nom: 'Beye' } },
      { id: 'h2', action: 'genere', createdAt: new Date('2026-09-10T08:01:00Z'), acteur: { prenom: 'Balla', nom: 'Beye' } },
      { id: 'h3', action: 'consulte_via_lien', createdAt: new Date('2026-09-11T09:00:00Z'), acteur: null },
    ]);

    const r = await RapportsService.historique('rap-1', ORG);

    expect(r.historique.map((h) => h.libelle)).toEqual([
      'Rapport créé', 'PDF généré', 'Rapport consulté via lien',
    ]);
    expect(r.historique[0].acteur).toBe('Balla Beye');
    expect(r.historique[2].acteur).toBeNull();
  });

  it('le téléchargement est journalisé', async () => {
    const { Readable } = require('node:stream');
    brouillon({ statut: 'genere', fichier_url: '/uploads/rapports/r.pdf' });
    mockOuvrirFichier.mockResolvedValue({ stream: Readable.from(['%PDF']), taille: 4 });

    const r = await RapportsService.fichier('rap-1', ORG, { utilisateurId: 'u1' });

    expect(r.success).toBe(true);
    expect(r.contentType).toBe('application/pdf');
    expect(actions('rap-1')).toEqual(['telecharge']);
  });

  it('demander l’Excel d’un rapport qui n’en a pas explique quoi faire', async () => {
    brouillon({ statut: 'genere', fichier_url: '/uploads/rapports/r.pdf' });

    const r = await RapportsService.fichier('rap-1', ORG, { format: 'xlsx' });

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Excel/);
  });

  it('liste les modèles du § 5 pour l’écran', () => {
    expect(RapportsService.modeles().map((m) => m.id)).toEqual(R.CODES_MODELE);
  });
});
