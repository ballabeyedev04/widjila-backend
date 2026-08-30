'use strict';

/**
 * Tests — cloisonnement des références du référentiel sur une réserve.
 *
 * `phaseId` et `corpsEtatId` arrivent en simples UUID dans le corps de la
 * requête. Rien ne les contrôlait : on pouvait rattacher une réserve à la
 * phase ou au métier d'un AUTRE client, dont le nom réapparaissait ensuite
 * dans chaque lecture de la réserve — une fuite inter-tenant par jointure.
 *
 * Ce qui doit être verrouillé :
 *
 *   1. une valeur d'une autre organisation est REFUSÉE ;
 *   2. le référentiel STANDARD (`organisationId` NULL) reste accepté — c'est
 *      le catalogue commun, le fermer viderait les listes de choix ;
 *   3. une phase de PLANNING (`chantierId` renseigné) n'est pas une valeur
 *      recevable de ce champ, même dans la bonne organisation ;
 *   4. le contrôle vaut à la CRÉATION comme à la MODIFICATION — ne le poser
 *      qu'à la création laisserait la porte ouverte par un simple PUT.
 */

jest.mock('../models/index.js', () => ({
  Phase: { findOne: jest.fn() },
  CorpsEtat: { findOne: jest.fn() },
  Reserve: {}, ReservePosition: {}, ReserveHistorique: {}, Commentaire: {},
  Media: {}, Chantier: {}, Batiment: {}, Etage: {}, Zone: {}, Lot: {}, Plan: {},
  Organisation: {}, Utilisateur: {}, PieceJointe: {}, ReserveAffectation: {},
  Signature: {}, Partenaire: {},
}));
jest.mock('../config/db.js', () => ({ transaction: jest.fn(), query: jest.fn() }));
jest.mock('../modules/notification/service/notification.service.js', () => ({}));

const { Op } = require('sequelize');
const { Phase, CorpsEtat } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

const ORG = 'org-1';

beforeEach(() => jest.clearAllMocks());

describe('_verifierPhase', () => {
  it('accepte une phase visible par l’organisation', async () => {
    Phase.findOne.mockResolvedValue({ id: 'ph-1' });

    expect(await ReserveService._verifierPhase(ORG, 'ph-1')).toBeNull();
  });

  it('refuse une phase d’une autre organisation', async () => {
    // Le filtre ne la ramène pas : du point de vue du service, elle n'existe
    // pas — c'est la bonne réponse, elle ne révèle rien de son existence.
    Phase.findOne.mockResolvedValue(null);

    const erreur = await ReserveService._verifierPhase(ORG, 'ph-autre-org');

    expect(erreur).toBe('Phase introuvable dans le référentiel de votre organisation');
  });

  it('interroge le RÉFÉRENTIEL seul, standard compris', async () => {
    Phase.findOne.mockResolvedValue({ id: 'ph-1' });

    await ReserveService._verifierPhase(ORG, 'ph-1');

    const where = Phase.findOne.mock.calls[0][0].where;
    // `chantierId: null` écarte les phases de PLANNING : elles vivent dans la
    // même table mais ne sont pas des valeurs de ce champ.
    expect(where.chantierId).toBeNull();
    // Le catalogue standard de la plateforme reste accepté, sans quoi une
    // organisation qui n'a créé aucune phase n'aurait plus aucun choix.
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });
});

describe('_verifierCorpsEtat', () => {
  it('accepte un métier visible par l’organisation', async () => {
    CorpsEtat.findOne.mockResolvedValue({ id: 'ce-1' });

    expect(await ReserveService._verifierCorpsEtat(ORG, 'ce-1')).toBeNull();
  });

  it('refuse un métier d’une autre organisation', async () => {
    CorpsEtat.findOne.mockResolvedValue(null);

    const erreur = await ReserveService._verifierCorpsEtat(ORG, 'ce-autre-org');

    expect(erreur).toContain('introuvable');
  });

  it('accepte le catalogue standard de la plateforme', async () => {
    CorpsEtat.findOne.mockResolvedValue({ id: 'ce-standard' });

    await ReserveService._verifierCorpsEtat(ORG, 'ce-standard');

    const where = CorpsEtat.findOne.mock.calls[0][0].where;
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });
});

describe('_verifierReferences — branchement', () => {
  it('refuse dès que la phase n’est pas visible', async () => {
    Phase.findOne.mockResolvedValue(null);

    const erreur = await ReserveService._verifierReferences(ORG, { phaseId: 'ph-autre' });

    expect(erreur).toContain('Phase introuvable');
  });

  it('refuse dès que le corps d’état n’est pas visible', async () => {
    CorpsEtat.findOne.mockResolvedValue(null);

    const erreur = await ReserveService._verifierReferences(ORG, { corpsEtatId: 'ce-autre' });

    expect(erreur).toContain('introuvable');
  });

  it('laisse passer quand les deux sont visibles', async () => {
    Phase.findOne.mockResolvedValue({ id: 'ph-1' });
    CorpsEtat.findOne.mockResolvedValue({ id: 'ce-1' });

    const erreur = await ReserveService._verifierReferences(
      ORG, { phaseId: 'ph-1', corpsEtatId: 'ce-1' }
    );

    expect(erreur).toBeNull();
  });

  it('n’interroge rien quand les champs sont absents', async () => {
    // Une réserve historique n'a ni phase ni corps d'état : la modifier ne
    // doit pas se mettre à échouer sur des champs qu'elle n'a jamais eus.
    const erreur = await ReserveService._verifierReferences(ORG, {});

    expect(erreur).toBeNull();
    expect(Phase.findOne).not.toHaveBeenCalled();
    expect(CorpsEtat.findOne).not.toHaveBeenCalled();
  });
});
