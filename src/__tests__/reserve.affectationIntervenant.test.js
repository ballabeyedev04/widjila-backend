'use strict';

/**
 * Tests — affecter une réserve à un INTERVENANT de l'annuaire du chantier.
 *
 * ## Le bug corrigé : « Entreprise introuvable »
 *
 * L'écran « Choisir qui affecter » propose deux onglets. L'onglet
 * « Intervenant » liste l'ANNUAIRE du chantier — la table `partenaires` — mais
 * envoyait l'identifiant retenu dans le champ `entrepriseId`, qui référence
 * `organisations`.
 *
 * Le serveur cherchait donc une ORGANISATION portant un identifiant de
 * PARTENAIRE. Il n'en trouvait aucune et répondait « Entreprise introuvable »
 * pour une entreprise qui existait bel et bien : elle était simplement rangée
 * dans l'autre table.
 *
 * ## Pourquoi on ne pouvait pas « traduire » l'un en l'autre
 *
 * La plupart des entreprises d'un chantier n'ont AUCUN compte sur la
 * plateforme : c'est la raison d'être de `partenaires`. La réserve elle-même
 * applique déjà cette distinction (`reserves.partenaire_id` à côté de
 * `reserves.entreprise_id`) ; l'affectation était le seul endroit du produit à
 * ne pas le faire.
 */

jest.mock('../config/db.js', () => ({
  query: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Reserve: { findByPk: jest.fn(), findOne: jest.fn() },
  Chantier: { findByPk: jest.fn(), findOne: jest.fn() },
  PieceJointe: {},
  ReserveAffectation: { create: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), findOne: jest.fn() },
  Utilisateur: { findOne: jest.fn(), findByPk: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  Partenaire: { findOne: jest.fn() },
  Signature: { findAll: jest.fn(), create: jest.fn() },
  ReserveHistorique: { create: jest.fn() },
  ReservePosition: {},
  Media: {},
  Commentaire: {},
  CorpsEtat: {},
  Phase: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Plan: { findOne: jest.fn(), findByPk: jest.fn() },
}));

const sequelize = require('../config/db.js');
const {
  Reserve, Chantier, ReserveAffectation, Utilisateur, Organisation, Partenaire, ReserveHistorique,
} = require('../models/index.js');
const ReserveExtraService = require('../modules/reserve/service/reserveExtra.service.js');
const { affecterReserveSchema } = require('../modules/reserve/validation/reserve.validation.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const RESERVE = '22222222-2222-4222-8222-222222222222';
const PARTENAIRE = '33333333-3333-4333-8333-333333333333';
const UTILISATEUR = '44444444-4444-4444-8444-444444444444';

/** Une transaction qui n'échoue jamais — on teste la logique, pas Postgres. */
function transactionMuette() {
  const t = { commit: jest.fn(), rollback: jest.fn() };
  sequelize.transaction.mockResolvedValue(t);
  return t;
}

beforeEach(() => {
  jest.clearAllMocks();
  transactionMuette();

  // La réserve existe et appartient bien à l'organisation appelante.
  //
  // `_verifierReserve` charge la réserve AVEC son chantier et vérifie que la
  // jointure a bien ramené quelque chose : le double doit donc porter
  // `chantier`, sinon toute affectation est refusée avant le moindre contrôle.
  Reserve.findByPk.mockResolvedValue({
    id: RESERVE,
    chantierId: 'c-1',
    chantier: { id: 'c-1', organisationId: ORG },
  });
  Chantier.findByPk.mockResolvedValue({ id: 'c-1', organisationId: ORG });
  Chantier.findOne.mockResolvedValue({ id: 'c-1', organisationId: ORG });

  ReserveAffectation.create.mockImplementation(async (valeurs) => ({ id: 'aff-1', ...valeurs }));
  ReserveAffectation.findByPk.mockResolvedValue({
    id: 'aff-1',
    partenaire: { id: PARTENAIRE, nom: 'SARL Diallo Étanchéité', type: 'sous_traitant' },
  });
  ReserveHistorique.create.mockResolvedValue({ id: 'h-1' });
});

describe('le schéma accepte les trois natures de destinataire', () => {
  it('accepte `partenaireId` — le cas qui échouait', () => {
    expect(affecterReserveSchema.validate({ partenaireId: PARTENAIRE }).error).toBeUndefined();
  });

  it('accepte toujours `utilisateurId` et `entrepriseId`', () => {
    expect(affecterReserveSchema.validate({ utilisateurId: UTILISATEUR }).error).toBeUndefined();
    expect(affecterReserveSchema.validate({ entrepriseId: ORG }).error).toBeUndefined();
  });

  it('refuse une affectation SANS destinataire, avec un message lisible', () => {
    const { error } = affecterReserveSchema.validate({});
    expect(error).toBeDefined();
    expect(error.message).toContain('intervenant');
  });
});

describe('affecter à un intervenant de l’annuaire', () => {
  it('enregistre `partenaireId`, et ne cherche AUCUNE organisation', async () => {
    Partenaire.findOne.mockResolvedValue({ id: PARTENAIRE });

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { partenaireId: PARTENAIRE });

    expect(r.success).toBe(true);
    expect(ReserveAffectation.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ partenaireId: PARTENAIRE, entrepriseId: null, utilisateurId: null }),
    );
    // La régression exacte : chercher une organisation avec un id de partenaire.
    expect(Organisation.findByPk).not.toHaveBeenCalled();
  });

  it('refuse un partenaire d’une AUTRE organisation', async () => {
    // `partenaireId` arrive en simple UUID dans le corps de la requête : rien
    // n'empêcherait sinon de désigner l'entreprise d'un autre client.
    Partenaire.findOne.mockResolvedValue(null);

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { partenaireId: PARTENAIRE });

    expect(r.success).toBe(false);
    expect(ReserveAffectation.create).not.toHaveBeenCalled();
  });

  it('historise l’affectation avec son destinataire', async () => {
    // « Toute modification est historisée » — et c'est la seule trace de qui a
    // désigné l'intervenant.
    Partenaire.findOne.mockResolvedValue({ id: PARTENAIRE });

    await ReserveExtraService.affecter(ORG, RESERVE, { partenaireId: PARTENAIRE }, null, UTILISATEUR);

    const historique = ReserveHistorique.create.mock.calls[0][0];
    expect(historique.action).toBe('affectation');
    expect(historique.utilisateurId).toBe(UTILISATEUR);
    expect(historique.nouvelles_valeurs.partenaireId).toBe(PARTENAIRE);
  });

  it('rend l’affectation AVEC son destinataire, pas la ligne brute', async () => {
    // `create` ne rend que des clés étrangères : le client insérait la ligne
    // telle quelle en tête de liste et affichait « — » à la place du nom,
    // jusqu'au rechargement suivant — juste après le geste où l'on veut
    // vérifier qu'on a désigné la bonne entreprise.
    Partenaire.findOne.mockResolvedValue({ id: PARTENAIRE });

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { partenaireId: PARTENAIRE });

    expect(ReserveAffectation.findByPk).toHaveBeenCalledWith('aff-1', expect.anything());
    expect(r.affectation.partenaire.nom).toBe('SARL Diallo Étanchéité');
  });
});

describe('les autres destinataires ne changent pas de comportement', () => {
  it('un membre de l’équipe passe toujours par `utilisateurId`', async () => {
    Utilisateur.findOne.mockResolvedValue({ id: UTILISATEUR, organisationId: ORG });

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { utilisateurId: UTILISATEUR });

    expect(r.success).toBe(true);
    expect(ReserveAffectation.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ utilisateurId: UTILISATEUR, partenaireId: null }),
    );
  });

  it('un compte d’une autre organisation reste refusé', async () => {
    Utilisateur.findOne.mockResolvedValue(null);

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { utilisateurId: UTILISATEUR });

    expect(r.success).toBe(false);
    expect(r.message).toContain('Utilisateur');
  });

  it('une réserve d’une autre organisation est refusée avant tout contrôle', async () => {
    // La jointure sur le chantier filtré par organisation ne ramène rien :
    // c'est le cloisonnement multi-tenant de `_verifierReserve`.
    Reserve.findByPk.mockResolvedValue(null);

    const r = await ReserveExtraService.affecter(ORG, RESERVE, { partenaireId: PARTENAIRE });

    expect(r.success).toBe(false);
    expect(Partenaire.findOne).not.toHaveBeenCalled();
    expect(ReserveAffectation.create).not.toHaveBeenCalled();
  });
});
