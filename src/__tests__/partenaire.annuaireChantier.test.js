'use strict';

/**
 * L'annuaire d'un chantier inclut les intervenants de l'ORGANISATION.
 *
 * Un intervenant ajouté depuis la page « Intervenants » (sans chantier)
 * n'apparaissait pas dans le filtre « Entreprise » des rapports : la liste
 * du chantier filtrait sur le seul `chantierId`.
 */

jest.mock('../models/index.js', () => ({
  Partenaire: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
  Chantier: { findOne: jest.fn(), findByPk: jest.fn() },
}));

const { Op } = require('sequelize');
const { Partenaire, Chantier } = require('../models/index.js');
const PartenaireService = require('../modules/organisation/service/partenaire.service.js');

const ORG = 'org-1';
const CHANTIER = 'ch-1';

beforeEach(() => {
  jest.clearAllMocks();
  Partenaire.findAll.mockResolvedValue([]);
});

describe('annuaire du chantier', () => {
  it('liste les fiches du chantier ET celles de l’organisation', async () => {
    await PartenaireService.listPartenaires(ORG, CHANTIER);

    const { where } = Partenaire.findAll.mock.calls[0][0];
    expect(where.organisationId).toBe(ORG);
    expect(where[Op.or]).toEqual([{ chantierId: CHANTIER }, { chantierId: null }]);
  });

  it('reste cloisonné à l’organisation, filtres conservés', async () => {
    await PartenaireService.listPartenaires(ORG, CHANTIER, { actif: 'true', type: 'sous_traitant' });

    const { where } = Partenaire.findAll.mock.calls[0][0];
    expect(where).toMatchObject({ organisationId: ORG, actif: true, type: 'sous_traitant' });
  });

  it('sans chantier : tout l’annuaire de l’organisation, comme avant', async () => {
    await PartenaireService.listPartenaires(ORG);

    const { where } = Partenaire.findAll.mock.calls[0][0];
    expect(where).toEqual({ organisationId: ORG });
  });

  it('chantier introuvable : aucune fiche plutôt qu’un annuaire élargi', async () => {
    Chantier.findByPk.mockResolvedValue(null);
    expect(await PartenaireService.annuaireDuChantier(CHANTIER)).toEqual({ id: null });
  });

  it('chantier connu : son organisation borne l’annuaire', async () => {
    Chantier.findByPk.mockResolvedValue({ organisationId: ORG });
    const where = await PartenaireService.annuaireDuChantier(CHANTIER);
    expect(where.organisationId).toBe(ORG);
    expect(where[Op.or]).toEqual([{ chantierId: CHANTIER }, { chantierId: null }]);
  });
});
