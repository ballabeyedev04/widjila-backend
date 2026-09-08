'use strict';

/**
 * Tests — conformité au cahier technique Widjila (v1.0, septembre 2026).
 *
 * Trois exigences du document qui touchaient au stockage et au versionnement,
 * et qu'aucun test ne couvrait :
 *
 *  - § 4  : un plan porte une DISCIPLINE (« Architecture », « Électricité »…)
 *           et une DATE DU PLAN, distincte de sa date de dépôt ;
 *  - § 5  : les fichiers sont rangés `plans/projet_{id}/batiment_X/niveau_Y/`
 *           et non dans un dossier unique ;
 *  - § 15 : la version courante est DÉSIGNÉE (`is_current = true`), et le
 *           dépôt d'une nouvelle version retire le drapeau à la précédente.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
}));

jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: jest.fn(),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/index.js', () => ({
  Plan: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), max: jest.fn(), update: jest.fn(), count: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Batiment: { findOne: jest.fn(), findByPk: jest.fn() },
  Etage: { findByPk: jest.fn() },
  Zone: { findByPk: jest.fn() },
  Reserve: { findAll: jest.fn() },
  ReservePosition: {},
  Media: {},
  Organisation: {},
  PlanHotspot: {},
  Annotation: { destroy: jest.fn() },
  Utilisateur: {},
}));

const sequelize = require('../config/db.js');
const { storeFile } = require('../infrastructure/storage.service.js');
const { Plan, Chantier, Batiment, Etage } = require('../models/index.js');
const PlanService = require('../modules/plan/service/plan.service.js');
const { uploadPlanSchema } = require('../modules/plan/validation/plan.validation.js');

const ORG = 'org-1';
const CHANTIER = '11111111-1111-4111-8111-111111111111';

/** Un fichier PDF minimal, tel que multer le remet au service. */
const fichier = { buffer: Buffer.from('%PDF-1.4'), originalname: 'Niveau R+2.pdf' };

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockResolvedValue({ commit: jest.fn(), rollback: jest.fn() });
  sequelize.query.mockResolvedValue([]);

  Chantier.findOne.mockResolvedValue({ id: CHANTIER, statut: 'en_cours' });
  Plan.max.mockResolvedValue(null);
  Plan.create.mockImplementation(async (v) => ({ id: 'plan-neuf', ...v }));
  Plan.update.mockResolvedValue([1]);
  storeFile.mockResolvedValue('/uploads/plans/projet_x/fichier.pdf');
});

describe('§ 4 — la discipline et la date du plan', () => {
  it('le schéma accepte `type_plan` et `date_plan`', () => {
    const { error } = uploadPlanSchema.validate({
      chantierId: CHANTIER,
      nom: 'Niveau R+2',
      type_plan: 'Électricité',
      date_plan: '2026-03-03',
    });
    expect(error).toBeUndefined();
  });

  it('les deux restent FACULTATIFS', () => {
    // Un chantier de maison individuelle n'a qu'un jeu de plans et n'a rien à
    // distinguer ; une date inconnue vaut mieux qu'une date inventée.
    expect(uploadPlanSchema.validate({ chantierId: CHANTIER, nom: 'Plan de masse' }).error)
      .toBeUndefined();
  });

  it('refuse une date de plan absurdement lointaine', () => {
    // Un plan daté de 2040 est une faute de frappe, pas une prévision. Un an
    // d'avance reste toléré : les plans d'exécution sont datés en amont.
    const dans5Ans = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000).toISOString();
    expect(uploadPlanSchema.validate({ chantierId: CHANTIER, nom: 'X', date_plan: dans5Ans }).error)
      .toBeDefined();
  });

  it('les enregistre au dépôt', async () => {
    await PlanService.upload(ORG, CHANTIER, {
      nom: 'Niveau R+2',
      type_plan: 'Électricité',
      date_plan: '2026-03-03',
    }, fichier);

    expect(Plan.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type_plan: 'Électricité', date_plan: '2026-03-03' }),
    );
  });
});

describe('§ 5 — le rangement des fichiers', () => {
  it('range un plan sous son projet, son bâtiment et son niveau', async () => {
    Batiment.findOne.mockResolvedValue({ id: 'bat-1' });
    Etage.findByPk.mockResolvedValue({ id: 'et-1', batimentId: 'bat-1', batiment: { id: 'bat-1' } });
    Batiment.findByPk.mockResolvedValue({ id: 'bat-1', nom: 'Bâtiment A' });

    await PlanService.upload(ORG, CHANTIER, { nom: 'Niveau R+2', etageId: 'et-1' }, fichier);

    const dossier = storeFile.mock.calls[0][2];
    expect(dossier).toContain(`plans/projet_${CHANTIER}`);
    expect(dossier).toContain('batiment_Batiment_A');
  });

  it('range un plan GLOBAL directement sous son projet', async () => {
    // Inventer un dossier « batiment_aucun » ne rangerait rien : cela
    // ajouterait un cran vide à traverser.
    await PlanService.upload(ORG, CHANTIER, { nom: 'Plan de masse' }, fichier);

    expect(storeFile.mock.calls[0][2]).toBe(`plans/projet_${CHANTIER}`);
  });

  it('assainit les noms saisis par l’utilisateur', async () => {
    // Les noms viennent d'un formulaire : « Bât. A / Niveau -3 » contient des
    // accents, des points et une barre oblique — celle-ci créerait un niveau
    // de dossier fantôme.
    Batiment.findOne.mockResolvedValue({ id: 'bat-1' });
    Batiment.findByPk.mockResolvedValue({ id: 'bat-1', nom: 'Bât. A / Aile Ouest' });

    await PlanService.upload(ORG, CHANTIER, { nom: 'X', batimentId: 'bat-1' }, fichier);

    const dossier = storeFile.mock.calls[0][2];
    // Un seul niveau après `batiment_` : la barre oblique n'en a pas créé un.
    expect(dossier.split('/')).toHaveLength(3);
    expect(dossier).not.toContain('..');
    expect(dossier).toMatch(/^plans\/projet_[\w-]+\/batiment_[\w.+-]+$/);
  });
});

describe('§ 15 — la version courante', () => {
  it('le nouveau dépôt devient la version courante', async () => {
    await PlanService.upload(ORG, CHANTIER, { nom: 'Niveau R+2' }, fichier);

    expect(Plan.create.mock.calls[0][0]).toEqual(expect.objectContaining({ is_current: true }));
  });

  it('et retire le drapeau aux versions précédentes, DANS la transaction', async () => {
    // Deux versions courantes simultanées feraient apparaître le même plan
    // deux fois dans chaque liste, sans que rien ne dise laquelle est la bonne.
    await PlanService.upload(ORG, CHANTIER, { nom: 'Niveau R+2' }, fichier);

    expect(Plan.update).toHaveBeenCalledTimes(1);
    const [valeurs, options] = Plan.update.mock.calls[0];
    expect(valeurs).toEqual({ is_current: false });
    expect(options.where).toEqual(
      expect.objectContaining({ chantierId: CHANTIER, nom: 'Niveau R+2' }),
    );
    // La MÊME transaction que la création : sinon, une panne entre les deux
    // laisserait le chantier sans aucune version courante.
    expect(options.transaction).toBeDefined();
  });

  it('les listes ne gardent que la version courante', async () => {
    Plan.findAll.mockResolvedValue([
      { id: 'v3', chantierId: CHANTIER, nom: 'R+2', version: 3, is_current: true, dataValues: {} },
      { id: 'v2', chantierId: CHANTIER, nom: 'R+2', version: 2, is_current: false, dataValues: {} },
      { id: 'v1', chantierId: CHANTIER, nom: 'R+2', version: 1, is_current: false, dataValues: {} },
    ]);

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.plans.map((p) => p.id)).toEqual(['v3']);
  });

  it('retombe sur le plus grand numéro si AUCUN drapeau n’est posé', async () => {
    // Les secondes qui séparent le déploiement du code de l'exécution de la
    // migration. Sans ce repli, la liste répondrait VIDE — un écran vide pour
    // un chantier plein de plans est le pire résultat possible.
    Plan.findAll.mockResolvedValue([
      { id: 'v3', chantierId: CHANTIER, nom: 'R+2', version: 3, is_current: undefined, dataValues: {} },
      { id: 'v2', chantierId: CHANTIER, nom: 'R+2', version: 2, is_current: undefined, dataValues: {} },
    ]);

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.plans.map((p) => p.id)).toEqual(['v3']);
  });
});
