'use strict';

/**
 * Tests — middlewares/checkOrganisation.middleware.js (audit — Bugs &
 * fiabilité §1). C'est LE garde-fou d'isolation multi-tenant : sans lui,
 * n'importe quel compte actif peut lire/modifier une ressource (chantier,
 * réserve…) appartenant à une AUTRE organisation en devinant/énumérant son
 * id. Le modèle est mocké (`findByPk`) pour tester la logique d'autorisation
 * indépendamment de la base de données.
 */

const checkOrganisation = require('../middlewares/checkOrganisation.middleware.js');

function fakeModel(resource) {
  return { findByPk: jest.fn().mockResolvedValue(resource) };
}

async function run({ model, whereKey, params, user }) {
  const req = { params, user };
  const next = jest.fn();
  await checkOrganisation(model, whereKey)(req, {}, next);
  return { req, next };
}

describe('checkOrganisation.middleware', () => {
  test('laisse passer sans requêter le modèle si aucun id n\'est fourni', async () => {
    const model = fakeModel(null);
    const { next } = await run({
      model, whereKey: 'organisationId', params: {}, user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    expect(model.findByPk).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  test('404 (NotFoundError) si la ressource n\'existe pas', async () => {
    const model = fakeModel(null);
    const { next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/introuvable/i);
  });

  test('autorise l\'accès quand la ressource appartient à l\'organisation de l\'utilisateur', async () => {
    const model = fakeModel({ id: 'chantier-1', organisationId: 'org-1' });
    const { req, next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    expect(next).toHaveBeenCalledWith();
    expect(req.resource).toEqual({ id: 'chantier-1', organisationId: 'org-1' });
  });

  test('REFUSE (ForbiddenError) l\'accès à une ressource d\'une autre organisation', async () => {
    const model = fakeModel({ id: 'chantier-1', organisationId: 'org-AUTRE' });
    const { next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/accès refusé/i);
    expect(err.statusCode ?? err.status).not.toBe(undefined); // ForbiddenError porte bien un code HTTP
  });

  test('compare les organisationId comme des chaînes (évite un faux-refus UUID vs objet)', async () => {
    // Reproduit un piège classique : comparer avec `===` deux valeurs qui
    // représentent le même UUID mais ne sont pas strictement égales
    // (ex: instance Sequelize vs chaîne brute). Le middleware doit passer
    // par String(...) des deux côtés.
    const model = fakeModel({ id: 'chantier-1', organisationId: { toString: () => 'org-1' } });
    const { next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    expect(next).toHaveBeenCalledWith();
  });

  test('le rôle Admin (super-admin plateforme) contourne l\'isolation multi-tenant', async () => {
    const model = fakeModel({ id: 'chantier-1', organisationId: 'org-AUTRE' });
    const { next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'Admin', organisationId: null },
    });
    expect(next).toHaveBeenCalledWith();
  });

  test('propage une erreur inattendue du modèle vers next(err) plutôt que de la laisser fuiter', async () => {
    const model = { findByPk: jest.fn().mockRejectedValue(new Error('connexion DB perdue')) };
    const { next } = await run({
      model, whereKey: 'organisationId', params: { id: 'chantier-1' },
      user: { role: 'ChefProjet', organisationId: 'org-1' },
    });
    expect(next.mock.calls[0][0].message).toBe('connexion DB perdue');
  });
});
