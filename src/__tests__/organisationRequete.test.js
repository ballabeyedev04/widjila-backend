'use strict';

/**
 * Résolution de l'organisation d'une requête (utils/organisationRequete.js).
 *
 * Le point sensible n'est pas la remontée elle-même mais QUI la déclenche :
 * seul le super-admin plateforme sort de sa propre organisation. Un
 * utilisateur normal doit toujours rester cadré sur la sienne, quoi qu'il
 * mette dans l'URL — sinon la remontée devient un contournement de
 * l'isolation multi-tenant.
 */

const modeles = {};
jest.mock('../models/index.js', () => modeles);

const { organisationCible, estSuperAdmin } = require('../utils/organisationRequete.js');

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';

beforeEach(() => {
  modeles.Chantier = { findByPk: jest.fn() };
  modeles.Plan = { findByPk: jest.fn() };
  modeles.Reserve = { findByPk: jest.fn() };
  modeles.Annotation = { findByPk: jest.fn() };
  modeles.PieceJointe = { findByPk: jest.fn() };
});

const requete = (role, organisationId, resource = undefined) => ({
  user: { role, organisationId },
  resource,
});

describe('estSuperAdmin', () => {
  it('ne reconnaît que le rôle Admin', () => {
    expect(estSuperAdmin({ role: 'Admin' })).toBe(true);
    expect(estSuperAdmin({ role: 'ChefProjet' })).toBe(false);
    expect(estSuperAdmin(undefined)).toBe(false);
  });
});

describe('organisationCible', () => {
  it("garde un utilisateur normal dans SON organisation, sans lire la base", async () => {
    const org = await organisationCible(requete('ChefProjet', ORG_A), { chantierId: 'chantier-du-client-b' });
    expect(org).toBe(ORG_A);
    expect(modeles.Chantier.findByPk).not.toHaveBeenCalled();
  });

  it('résout un chantier pour le super-admin', async () => {
    modeles.Chantier.findByPk.mockResolvedValue({ organisationId: ORG_B });
    const org = await organisationCible(requete('Admin', null), { chantierId: 'c1' });
    expect(org).toBe(ORG_B);
  });

  it('remonte réserve → chantier → organisation', async () => {
    modeles.Reserve.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue({ organisationId: ORG_B });
    const org = await organisationCible(requete('Admin', null), { reserveId: 'r1' });
    expect(org).toBe(ORG_B);
    expect(modeles.Reserve.findByPk).toHaveBeenCalledWith('r1', expect.any(Object));
  });

  it('remonte annotation → plan → chantier → organisation', async () => {
    modeles.Annotation.findByPk.mockResolvedValue({ planId: 'p1' });
    modeles.Plan.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue({ organisationId: ORG_A });
    const org = await organisationCible(requete('Admin', null), { annotationId: 'a1' });
    expect(org).toBe(ORG_A);
  });

  it('remonte pièce jointe → réserve → chantier → organisation', async () => {
    modeles.PieceJointe.findByPk.mockResolvedValue({ reserveId: 'r1' });
    modeles.Reserve.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue({ organisationId: ORG_B });
    const org = await organisationCible(requete('Admin', null), { pieceJointeId: 'pj1' });
    expect(org).toBe(ORG_B);
  });

  it('réutilise req.resource quand checkOrganisation l’a déjà chargé', async () => {
    const org = await organisationCible(requete('Admin', null, { organisationId: ORG_A }), { chantierId: 'c1' });
    expect(org).toBe(ORG_A);
    expect(modeles.Chantier.findByPk).not.toHaveBeenCalled();
  });

  it('lève NotFound sur une ressource inexistante', async () => {
    modeles.Reserve.findByPk.mockResolvedValue(null);
    await expect(organisationCible(requete('Admin', null), { reserveId: 'inconnu' }))
      .rejects.toThrow('Réserve introuvable');
  });

  it("retombe sur l'organisation du compte quand aucune cible n'est fournie", async () => {
    const org = await organisationCible(requete('Admin', null), {});
    expect(org).toBeNull();
  });

  it('ignore les identifiants absents et prend le premier renseigné', async () => {
    modeles.Chantier.findByPk.mockResolvedValue({ organisationId: ORG_A });
    const org = await organisationCible(requete('Admin', null), { reserveId: undefined, chantierId: 'c1' });
    expect(org).toBe(ORG_A);
    expect(modeles.Reserve.findByPk).not.toHaveBeenCalled();
  });
});
