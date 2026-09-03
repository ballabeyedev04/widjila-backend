'use strict';

/**
 * Tests — à la validation, le chantier est rattaché à celui qui l'a demandé.
 *
 * ## Le contexte
 *
 * Le cloisonnement (`_filtreCloisonnement`) laisse passer trois choses hors
 * rôles de gestion : les chantiers sans demandeur, ceux qu'on a demandés
 * soi-même, et ceux auxquels on est AFFECTÉ. La troisième porte s'appuie sur
 * `chantier_membres` — une table dont aucune migration n'existait, et que la
 * production n'avait donc jamais eue.
 *
 * Une fois la table en place, la validation y inscrit le demandeur. La porte
 * `demandeurId` le laissait déjà passer, mais c'est une coïncidence de
 * circuit, pas une appartenance : elle ne survivrait pas à un changement de
 * propriétaire, et elle ne dit rien aux autres écrans. L'affectation, elle,
 * décrit l'équipe.
 */

jest.mock('../models/index.js', () => ({
  Chantier: { findByPk: jest.fn() },
  Plan: { update: jest.fn().mockResolvedValue([0]) },
  ChantierMembre: { findOrCreate: jest.fn().mockResolvedValue([{}, true]) },
  Utilisateur: { findAll: jest.fn().mockResolvedValue([]) },
  Batiment: {}, Etage: {}, Zone: {}, Lot: {}, Reserve: {}, Phase: {},
  Inspection: {}, Annotation: {}, Document: {}, Rapport: {}, Checklist: {},
  Commentaire: {}, PieceJointe: {}, Organisation: {}, PlanHotspot: {},
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendChantierValidationEmail: jest.fn().mockResolvedValue(null),
}));

const { Chantier, ChantierMembre } = require('../models/index.js');
const ChantierService = require('../modules/chantier/service/chantier.service.js');

const VALIDEUR = { id: 'gestionnaire-1', role: 'ChefProjet' };

/** Demande en attente, telle que la renvoie `findByPk`. */
const demandeEnAttente = ({ demandeurId = 'entreprise-1', demandeur = null } = {}) => ({
  id: 'chantier-1',
  nom: 'Résidence Les Acacias',
  code: 'CH-001',
  statut: 'en_attente_validation',
  demandeurId,
  demandeur,
  update: jest.fn().mockResolvedValue(undefined),
});

describe('validerChantier — rattachement du demandeur', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ChantierMembre.findOrCreate.mockResolvedValue([{}, true]);
  });

  it('inscrit le demandeur comme membre du chantier validé', async () => {
    Chantier.findByPk.mockResolvedValue(demandeEnAttente());

    const res = await ChantierService.validerChantier('chantier-1', VALIDEUR);

    expect(res.success).toBe(true);
    expect(ChantierMembre.findOrCreate).toHaveBeenCalledTimes(1);
    const [args] = ChantierMembre.findOrCreate.mock.calls[0];
    expect(args.where).toEqual({ chantierId: 'chantier-1', utilisateurId: 'entreprise-1' });
  });

  it('passe par findOrCreate : revalider ne crée pas de doublon', async () => {
    // Un chantier rejeté puis corrigé repasse par ici. Un `create` sec
    // heurterait l'index unique (chantier, utilisateur) et ferait échouer une
    // validation parfaitement légitime.
    Chantier.findByPk.mockResolvedValue(demandeEnAttente());

    await ChantierService.validerChantier('chantier-1', VALIDEUR);

    expect(ChantierMembre.findOrCreate).toHaveBeenCalled();
  });

  it('n’inscrit personne quand la demande n’a pas de demandeur', async () => {
    // Chantier créé hors circuit (super-admin) : il est déjà visible de toute
    // l'organisation, il n'y a personne à rattacher.
    Chantier.findByPk.mockResolvedValue(demandeEnAttente({ demandeurId: null }));

    const res = await ChantierService.validerChantier('chantier-1', VALIDEUR);

    expect(res.success).toBe(true);
    expect(ChantierMembre.findOrCreate).not.toHaveBeenCalled();
  });

  it('valide quand même si le rattachement échoue', async () => {
    // Le chantier ouvert est l'essentiel, et le demandeur y accède de toute
    // façon par `demandeurId`. Bloquer une validation pour une ligne de
    // liaison serait disproportionné.
    Chantier.findByPk.mockResolvedValue(demandeEnAttente());
    ChantierMembre.findOrCreate.mockRejectedValue(new Error('contrainte violée'));

    const res = await ChantierService.validerChantier('chantier-1', VALIDEUR);

    expect(res.success).toBe(true);
    expect(res.message).toBe('Chantier validé');
  });

  it('refuse de valider ce qui n’est pas en attente — comportement inchangé', async () => {
    const actif = demandeEnAttente();
    actif.statut = 'en_cours';
    Chantier.findByPk.mockResolvedValue(actif);

    const res = await ChantierService.validerChantier('chantier-1', VALIDEUR);

    expect(res.success).toBe(false);
    expect(ChantierMembre.findOrCreate).not.toHaveBeenCalled();
  });
});
