'use strict';

/**
 * Tests — référentiel des CODES D'APPARTEMENT.
 *
 * Le client a demandé la même mécanique que pour les niveaux : « mettez une
 * liste des appartements : A001, A002, A003 jusqu'à A015 », servie par le
 * serveur, avec un « + » pour ajouter ce qui manque.
 *
 * Trois règles portent tout le reste, et sont vérifiées ici :
 *
 *   1. VISIBILITÉ — une organisation voit le catalogue standard et SES codes,
 *      jamais ceux d'une autre. C'est la seule barrière entre deux clients de
 *      la plateforme ;
 *   2. ÉCRITURE — un ajout depuis le mobile appartient à l'organisation qui le
 *      crée. Écrire dans le catalogue standard le pousserait à tous les
 *      clients, concurrents compris ;
 *   3. RETRAIT — un code se DÉSACTIVE, jamais ne se supprime : les
 *      appartements qui le portent garderaient une référence morte.
 *
 * Le modèle est doublé : ces règles vivent dans le service, pas dans la base.
 */

const mockCodeAppartement = {
  findAll: jest.fn(),
  findOne: jest.fn(),
  findByPk: jest.fn(),
  create: jest.fn(),
};

jest.mock('../models/index.js', () => ({
  CodeAppartement: mockCodeAppartement,
}));

const { Op } = require('sequelize');
const CodeAppartementService = require('../modules/referentiel/service/codeAppartement.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const AUTRE_ORG = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  mockCodeAppartement.findAll.mockResolvedValue([]);
  mockCodeAppartement.findOne.mockResolvedValue(null);
});

describe('lister', () => {
  it('sert le catalogue standard ET les codes de l’organisation', async () => {
    await CodeAppartementService.lister(ORG);

    const where = mockCodeAppartement.findAll.mock.calls[0][0].where;
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });

  it('ne renvoie que les codes ACTIFS', async () => {
    // Une liste de SAISIE : un code retiré ne doit plus être proposé, même si
    // des appartements le portent encore.
    await CodeAppartementService.lister(ORG);

    expect(mockCodeAppartement.findAll.mock.calls[0][0].where.actif).toBe(true);
  });

  it('sans organisation, ne sort JAMAIS du catalogue standard', async () => {
    // Le super-admin plateforme n'appartient à aucune organisation : lui
    // servir les codes de tout le monde exposerait les conventions d'un client
    // à qui n'en fait pas partie.
    await CodeAppartementService.lister(null);

    expect(mockCodeAppartement.findAll.mock.calls[0][0].where)
      .toMatchObject({ organisationId: null });
  });

  it('ordonne par rang, puis par code', async () => {
    // Le catalogue standard suit la numérotation naturelle (A001 avant A002) ;
    // un ajout se range en fin de liste.
    await CodeAppartementService.lister(ORG);

    expect(mockCodeAppartement.findAll.mock.calls[0][0].order)
      .toEqual([['ordre', 'ASC'], ['code', 'ASC']]);
  });
});

describe('creer', () => {
  it('rattache le code à l’organisation de l’appelant', async () => {
    mockCodeAppartement.create.mockResolvedValue({ id: 'c1', code: 'B12' });

    const res = await CodeAppartementService.creer(ORG, { code: 'B12' });

    expect(res.success).toBe(true);
    expect(mockCodeAppartement.create).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: ORG, code: 'B12' }),
    );
  });

  it('normalise le code en MAJUSCULES', async () => {
    // « a001 » et « A001 » désignent le même logement ; deux entrées
    // indiscernables à l'écran seraient un piège.
    mockCodeAppartement.create.mockResolvedValue({ id: 'c1' });

    await CodeAppartementService.creer(ORG, { code: '  b12  ' });

    expect(mockCodeAppartement.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'B12' }),
    );
  });

  it('REFUSE d’écrire dans le catalogue standard', async () => {
    // Sans organisation, la création pousserait le code à tous les clients de
    // la plateforme. C'est un geste d'administration, pas de saisie.
    const res = await CodeAppartementService.creer(null, { code: 'B12' });

    expect(res.success).toBe(false);
    expect(mockCodeAppartement.create).not.toHaveBeenCalled();
  });

  it('refuse un code vide', async () => {
    const res = await CodeAppartementService.creer(ORG, { code: '   ' });

    expect(res.success).toBe(false);
    expect(mockCodeAppartement.create).not.toHaveBeenCalled();
  });

  it('ne crée pas de doublon d’un code déjà visible', async () => {
    // L'utilisateur qui tape « A001 » veut le A001 du catalogue, pas un
    // second — deux entrées identiques ne se distingueraient pas.
    mockCodeAppartement.findOne.mockResolvedValue({ actif: true, organisationId: null });

    const res = await CodeAppartementService.creer(ORG, { code: 'A001' });

    expect(res.success).toBe(false);
    expect(mockCodeAppartement.create).not.toHaveBeenCalled();
  });

  it('RÉTABLIT un code de l’organisation qui avait été retiré', async () => {
    // Le ressaisir est une demande de le remettre en service, pas une erreur.
    const update = jest.fn().mockResolvedValue(undefined);
    mockCodeAppartement.findOne.mockResolvedValue({
      actif: false,
      organisationId: ORG,
      update,
    });

    const res = await CodeAppartementService.creer(ORG, { code: 'B12' });

    expect(res.success).toBe(true);
    expect(update).toHaveBeenCalledWith({ actif: true });
    expect(mockCodeAppartement.create).not.toHaveBeenCalled();
  });

  it('range un code sans rang EN FIN de liste', async () => {
    // On ne devine pas une position : « B12 » n'a pas de place évidente parmi
    // des A0xx, et l'insérer au milieu bousculerait une liste connue.
    mockCodeAppartement.create.mockResolvedValue({ id: 'c1' });

    await CodeAppartementService.creer(ORG, { code: 'B12' });

    expect(mockCodeAppartement.create).toHaveBeenCalledWith(
      expect.objectContaining({ ordre: 999 }),
    );
  });
});

describe('desactiver', () => {
  it('désactive au lieu de supprimer', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    mockCodeAppartement.findByPk.mockResolvedValue({ organisationId: ORG, update });

    const res = await CodeAppartementService.desactiver(ORG, 'c1');

    expect(res.success).toBe(true);
    expect(update).toHaveBeenCalledWith({ actif: false });
  });

  it('protège le catalogue standard', async () => {
    mockCodeAppartement.findByPk.mockResolvedValue({ organisationId: null, update: jest.fn() });

    const res = await CodeAppartementService.desactiver(ORG, 'c1');

    expect(res.success).toBe(false);
  });

  it('ne laisse pas retirer le code d’une AUTRE organisation', async () => {
    // Et répond « introuvable », pas « interdit » : confirmer l'existence
    // renseignerait sur le référentiel d'un autre client.
    mockCodeAppartement.findByPk.mockResolvedValue({ organisationId: AUTRE_ORG, update: jest.fn() });

    const res = await CodeAppartementService.desactiver(ORG, 'c1');

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
  });
});
