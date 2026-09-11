'use strict';

/**
 * Tests — audit de sécurité : circuit de validation des chantiers.
 *
 *  1. Un valideur ne tranche pas SA PROPRE demande (ChefProjet et
 *     MaitreOuvrage sont à la fois déposants et valideurs).
 *  2. La duplication est une création : elle suit le circuit. Elle produisait
 *     un chantier actif sans validation — y compris à partir d'une demande
 *     refusée ou en attente.
 *  3. La route de duplication applique le plafond de chantiers de la formule.
 */

const ChantierService = require('../modules/chantier/service/chantier.service.js');
const models = require('../models/index.js');
const sequelize = require('../config/db.js');

const { Chantier, Organisation, Utilisateur } = models;

afterEach(() => jest.restoreAllMocks());

const demande = (extra = {}) => ({
  id: 'c1', statut: 'en_attente_validation', demandeurId: 'u-chef', demandeur: null,
  update: jest.fn().mockResolvedValue(), ...extra,
});

describe('validerChantier / rejeterChantier — pas de verdict sur sa propre demande', () => {
  it('refuse la validation par le demandeur lui-même', async () => {
    const chantier = demande();
    jest.spyOn(Chantier, 'findByPk').mockResolvedValue(chantier);

    const r = await ChantierService.validerChantier('c1', { id: 'u-chef', role: 'ChefProjet' });

    expect(r.success).toBe(false);
    expect(chantier.update).not.toHaveBeenCalled();
  });

  it('refuse le rejet par le demandeur lui-même', async () => {
    const chantier = demande();
    jest.spyOn(Chantier, 'findByPk').mockResolvedValue(chantier);

    const r = await ChantierService.rejeterChantier('c1', { id: 'u-chef', role: 'MaitreOuvrage' }, 'motif');

    expect(r.success).toBe(false);
    expect(chantier.update).not.toHaveBeenCalled();
  });

  it('laisse un AUTRE valideur trancher', async () => {
    const chantier = demande();
    jest.spyOn(Chantier, 'findByPk').mockResolvedValue(chantier);
    jest.spyOn(models.ChantierMembre, 'findOrCreate').mockResolvedValue([{}, true]);
    jest.spyOn(models.Plan, 'update').mockResolvedValue([0]);
    // `transaction(fn)` et `transaction(options, fn)` (savepoint) : même exécution.
    jest.spyOn(sequelize, 'transaction').mockImplementation(async (a, b) => (typeof a === 'function' ? a : b)({ LOCK: { UPDATE: 'UPDATE' } }));

    const r = await ChantierService.validerChantier('c1', { id: 'u-moa', role: 'MaitreOuvrage' });

    expect(r.success).toBe(true);
    expect(chantier.update).toHaveBeenCalledWith(expect.objectContaining({ statut: 'en_preparation' }), expect.anything());
  });

  it('le helper n’arrête jamais le super-admin', () => {
    expect(ChantierService._refusVerdictSurSaDemande({ demandeurId: 'a' }, { id: 'a', role: 'Admin' })).toBeNull();
  });
});

describe('dupliquerChantier — la copie suit le circuit de validation', () => {
  const transaction = () => ({ commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() });

  it.each(['en_attente_validation', 'rejete'])('refuse de dupliquer une demande « %s »', async (statut) => {
    jest.spyOn(Chantier, 'findOne').mockResolvedValue({ id: 'c1', statut, demandeurId: 'u-ent' });
    const create = jest.spyOn(Chantier, 'create');

    const r = await ChantierService.dupliquerChantier('org', 'c1', {}, { id: 'u-ent', role: 'Entreprise' });

    expect(r.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('une copie faite par un non-Admin naît EN ATTENTE, avec son demandeur', async () => {
    jest.spyOn(Chantier, 'findOne').mockResolvedValue({
      id: 'c1', statut: 'en_cours', demandeurId: null, nom: 'Tour A', batiments: [], lots: [],
    });
    jest.spyOn(sequelize, 'transaction').mockResolvedValue(transaction());
    const create = jest.spyOn(Chantier, 'create').mockResolvedValue({ id: 'c2', nom: 'Tour A (copie)', code: 'CH-1' });
    jest.spyOn(Organisation, 'findByPk').mockResolvedValue({ id: 'org', nom: 'Org' });
    jest.spyOn(Utilisateur, 'findAll').mockResolvedValue([]);

    const auteur = { id: 'u-cond', role: 'ConducteurTravaux' };
    const r = await ChantierService.dupliquerChantier('org', 'c1', {}, auteur);

    expect(r.success).toBe(true);
    expect(create.mock.calls[0][0]).toMatchObject({ statut: 'en_attente_validation', demandeurId: 'u-cond' });
  });

  it('refuse de copier un chantier que l’auteur ne peut pas ouvrir', async () => {
    jest.spyOn(Chantier, 'findOne').mockResolvedValue({ id: 'c1', statut: 'en_cours', demandeurId: 'u-autre' });
    const create = jest.spyOn(Chantier, 'create');

    const r = await ChantierService.dupliquerChantier('org', 'c1', {}, { id: 'u-cond', role: 'ConducteurTravaux' });

    expect(r.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('la route de duplication pose le plafond de chantiers (verifierLimite)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'modules', 'chantier', 'route', 'chantier.route.js'), 'utf8'
    );
    const bloc = src.slice(src.indexOf("'/:id/dupliquer'"), src.indexOf('chantierController.dupliquerChantier'));
    expect(bloc).toContain("verifierLimite('chantiers')");
  });
});
