'use strict';

/**
 * Tests — audit de sécurité : intégrité des PREUVES (médias, signatures).
 *
 *  1. Médias : un sous-traitant ne dépose que sur une réserve qui lui est
 *     assignée (le média compte comme preuve de correction) ; les
 *     métadonnées probantes (date, position) sont contrôlées.
 *  2. Signature de réserve : « validation » / « refus » réservés au pilotage,
 *     une seule signature par personne et par type.
 *  3. Signature de document : le premier signataire n'est jamais écrasé, pas
 *     de double signature, pas de signature d'un document archivé.
 */

jest.mock('../models/index.js', () => ({
  Media: { findOne: jest.fn(), create: jest.fn(), count: jest.fn() },
  Reserve: { findByPk: jest.fn() },
  Inspection: { findByPk: jest.fn() },
  Chantier: {},
  ReserveAffectation: { count: jest.fn() },
  Signature: { count: jest.fn(), create: jest.fn() },
  ReserveHistorique: { create: jest.fn() },
  Document: { findByPk: jest.fn() },
  Checklist: { findOne: jest.fn() },
  ChecklistModele: { findOne: jest.fn() },
  PieceJointe: {}, Utilisateur: {}, Organisation: {}, Partenaire: {},
}));
jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: jest.fn(async () => '/uploads/photos/x.jpg'),
  deleteFile: jest.fn(async () => {}),
}));
jest.mock('../config/db.js', () => ({
  transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })),
  query: jest.fn(),
  define: jest.fn(),
}));
// Le service des réserves tire une longue chaîne de dépendances inutile ici.
jest.mock('../modules/reserve/service/reserve.service.js', () => ({}));

const models = require('../models/index.js');
const { storeFile } = require('../infrastructure/storage.service.js');
const MediaService = require('../modules/media/service/media.service.js');
const ReserveExtraService = require('../modules/reserve/service/reserveExtra.service.js');
const DocumentService = require('../modules/document/service/document.service.js');

const fichier = { buffer: Buffer.from('contenu-video'), originalname: 'x.mp4', size: 13 };

beforeEach(() => {
  jest.clearAllMocks();
  models.Reserve.findByPk.mockResolvedValue({ id: 'r1', chantierId: 'c1', assigneA: 'u-titulaire', chantier: { id: 'c1' } });
  models.Media.findOne.mockResolvedValue(null);
  models.Media.create.mockImplementation(async (v) => ({ id: 'm1', ...v }));
  models.ReserveAffectation.count.mockResolvedValue(0);
  models.Signature.count.mockResolvedValue(0);
  models.Signature.create.mockResolvedValue({ id: 's1' });
});

describe('Médias — sous-traitant et métadonnées', () => {
  it('refuse un sous-traitant NON assigné, avant tout stockage', async () => {
    const r = await MediaService.ajouterMedia('org', 'r1', 'video', fichier, {}, 'u-st', 'SousTraitant');

    expect(r.success).toBe(false);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('accepte un sous-traitant affecté à la réserve', async () => {
    models.ReserveAffectation.count.mockResolvedValue(1);
    const r = await MediaService.ajouterMedia('org', 'r1', 'video', fichier, {}, 'u-st', 'SousTraitant');
    expect(r.success).toBe(true);
  });

  it('ne restreint pas les autres rôles', async () => {
    const r = await MediaService.ajouterMedia('org', 'r1', 'video', fichier, {}, 'u-cond', 'ConducteurTravaux');
    expect(r.success).toBe(true);
  });

  it.each([
    ['latitude hors bornes', { latitude: 123 }],
    ['longitude non numérique', { longitude: 'abc' }],
    ['prise de vue dans le futur', { pris_le: new Date(Date.now() + 86_400_000).toISOString() }],
    ['date illisible', { pris_le: 'pas-une-date' }],
  ])('refuse %s', async (_l, meta) => {
    const r = await MediaService.ajouterMedia('org', 'r1', 'video', fichier, meta, 'u-cond', 'ConducteurTravaux');
    expect(r.success).toBe(false);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('refuse un type de média inconnu', async () => {
    const r = await MediaService.ajouterMedia('org', 'r1', 'executable', fichier, {}, 'u-cond', 'ConducteurTravaux');
    expect(r.success).toBe(false);
  });

  it('conserve des métadonnées valides', async () => {
    const pris = new Date(Date.now() - 60_000).toISOString();
    await MediaService.ajouterMedia('org', 'r1', 'video', fichier, { latitude: '14.7', longitude: '-17.4', pris_le: pris }, 'u', 'ChefProjet');
    expect(models.Media.create).toHaveBeenCalledWith(expect.objectContaining({ latitude: 14.7, longitude: -17.4 }));
  });
});

describe('Signature de réserve — verdicts réservés au pilotage', () => {
  it.each(['Client', 'SousTraitant', 'Pilote'])('refuse une « validation » signée par %s', async (role) => {
    const r = await ReserveExtraService.signer('org', 'r1', { type: 'validation' }, 'u', role);
    expect(r.success).toBe(false);
    expect(models.Signature.create).not.toHaveBeenCalled();
  });

  it('laisse un client apposer une signature simple', async () => {
    const r = await ReserveExtraService.signer('org', 'r1', { type: 'signature' }, 'u-client', 'Client');
    expect(r.success).toBe(true);
  });

  it('laisse le pilotage signer un refus', async () => {
    const r = await ReserveExtraService.signer('org', 'r1', { type: 'refus' }, 'u-bc', 'BureauControle');
    expect(r.success).toBe(true);
  });

  it('refuse une seconde signature du même type par la même personne', async () => {
    models.Signature.count.mockResolvedValue(1);
    const r = await ReserveExtraService.signer('org', 'r1', { type: 'signature' }, 'u', 'Client');
    expect(r.success).toBe(false);
  });

  it('le doublon est borné à l’ÉTAT COURANT : un nouveau cycle (refusée → corrigée → refusée) se signe', async () => {
    const modifieeLe = new Date('2026-09-10T10:00:00Z');
    models.Reserve.findByPk.mockResolvedValue({ id: 'r1', chantier: { id: 'c1' }, updatedAt: modifieeLe });

    await ReserveExtraService.signer('org', 'r1', { type: 'refus' }, 'u-bc', 'BureauControle');

    const { where } = models.Signature.count.mock.calls[0][0];
    const borne = Object.getOwnPropertySymbols(where.createdAt).map((s) => where.createdAt[s])[0];
    expect(borne).toEqual(modifieeLe);
  });
});

describe('Inspection signée — procès-verbal figé', () => {
  const InspectionService = require('../modules/inspection/service/inspection.service.js');
  const inspection = (statut) => ({ id: 'i1', statut, chantier: { id: 'c1' }, update: jest.fn() });

  it('refuse toute modification d’une inspection signée (statut compris)', async () => {
    const insp = inspection('signee');
    models.Inspection.findByPk.mockResolvedValue(insp);

    const r = await InspectionService.modifierInspection('org', 'i1', { statut: 'planifiee', compte_rendu: 'réécrit' });

    expect(r.success).toBe(false);
    expect(insp.update).not.toHaveBeenCalled();
  });

  it('refuse de cocher une ligne de checklist d’un PV signé', async () => {
    models.Inspection.findByPk.mockResolvedValue(inspection('signee'));

    const r = await InspectionService.cocherChecklist('org', 'i1', 'l1', { coche: true });

    expect(r.success).toBe(false);
    expect(models.Checklist.findOne).not.toHaveBeenCalled();
  });

  it('laisse modifier une inspection non signée — et la signer', async () => {
    const insp = inspection('en_cours');
    models.Inspection.findByPk.mockResolvedValue(insp);

    const r = await InspectionService.modifierInspection('org', 'i1', { statut: 'signee' });

    expect(r.success).toBe(true);
    expect(insp.update).toHaveBeenCalledWith({ statut: 'signee' });
  });
});

describe('Signature de document — intégrité du signataire', () => {
  const document = (extra = {}) => ({ id: 'd1', statut: 'actif', signataireId: null, update: jest.fn(), ...extra });

  it('ne réécrit PAS le premier signataire', async () => {
    const doc = document({ signataireId: 'u-premier' });
    models.Document.findByPk.mockResolvedValue(doc);

    const r = await DocumentService.signerDocument('org', 'd1', {}, 'u-second');

    expect(r.success).toBe(true);
    expect(doc.update).not.toHaveBeenCalled();
  });

  it('enregistre le premier signataire', async () => {
    const doc = document();
    models.Document.findByPk.mockResolvedValue(doc);

    await DocumentService.signerDocument('org', 'd1', {}, 'u-premier');

    expect(doc.update).toHaveBeenCalledWith(expect.objectContaining({ signataireId: 'u-premier' }), expect.anything());
  });

  it('refuse une double signature par la même personne', async () => {
    models.Document.findByPk.mockResolvedValue(document());
    models.Signature.count.mockResolvedValue(1);

    const r = await DocumentService.signerDocument('org', 'd1', {}, 'u');

    expect(r.success).toBe(false);
    expect(models.Signature.create).not.toHaveBeenCalled();
  });

  it('refuse de signer un document archivé', async () => {
    models.Document.findByPk.mockResolvedValue(document({ statut: 'archive' }));
    const r = await DocumentService.signerDocument('org', 'd1', {}, 'u');
    expect(r.success).toBe(false);
  });
});
