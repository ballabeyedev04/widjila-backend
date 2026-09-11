'use strict';

/**
 * Tests — `utils/migrationIdempotente.js`.
 *
 * Ce module fait des migrations des opérations REJOUABLES : sur une base
 * PostgreSQL neuve, la migration de rattrapage crée déjà toutes les tables, et
 * les migrations suivantes échouaient (« column … already exists »). Aucun
 * nouvel environnement ne pouvait être monté.
 *
 * Deux propriétés comptent, et ce sont elles qui sont vérifiées :
 *  1. un objet qui existe déjà n'est PAS recréé — et le contrôle a lieu AVANT
 *     l'ordre, jamais en rattrapant son erreur (dans une transaction
 *     PostgreSQL, la première erreur annule tout) ;
 *  2. un objet absent est créé exactement comme sans le module.
 */

const { idempotent, nomIndexParDefaut } = require('../utils/migrationIdempotente.js');

/** QueryInterface simulée : décrit l'état « existant » de la base. */
function queryInterface({ tables = [], colonnes = {}, index = [] } = {}) {
  return {
    showAllTables: jest.fn(async () => tables),
    describeTable: jest.fn(async (table) => colonnes[table] || {}),
    createTable: jest.fn(async () => 'cree'),
    addColumn: jest.fn(async () => 'ajoutee'),
    addIndex: jest.fn(async () => 'indexe'),
    removeColumn: jest.fn(async function removeColumn() { return this; }),
    sequelize: {
      query: jest.fn(async (_sql, { replacements }) => [index.includes(replacements.nom) ? [{ existe: 1 }] : []]),
    },
  };
}

describe('createTable', () => {
  it('ne recrée pas une table qui existe déjà', async () => {
    const qi = queryInterface({ tables: ['plans'] });

    await idempotent(qi).createTable('plans', {});

    expect(qi.createTable).not.toHaveBeenCalled();
  });

  it('reconnaît aussi les tables décrites en objet ({ tableName })', async () => {
    const qi = queryInterface({ tables: [{ tableName: 'plans' }] });

    await idempotent(qi).createTable({ tableName: 'plans' }, {});

    expect(qi.createTable).not.toHaveBeenCalled();
  });

  it('crée une table absente, avec ses attributs et options tels quels', async () => {
    const qi = queryInterface();
    const options = { transaction: 't1' };

    await idempotent(qi).createTable('job_executions', { id: {} }, options);

    expect(qi.createTable).toHaveBeenCalledWith('job_executions', { id: {} }, options);
    expect(qi.showAllTables).toHaveBeenCalledWith({ transaction: 't1' });
  });
});

describe('addColumn', () => {
  it('n’ajoute pas une colonne déjà présente', async () => {
    const qi = queryInterface({ colonnes: { chantiers: { demandeur_id: {} } } });

    await idempotent(qi).addColumn('chantiers', 'demandeur_id', { type: 'UUID' });

    expect(qi.addColumn).not.toHaveBeenCalled();
  });

  it('ajoute une colonne absente, dans la transaction de la migration', async () => {
    const qi = queryInterface({ colonnes: { chantiers: { id: {} } } });

    await idempotent(qi).addColumn('chantiers', 'demandeur_id', { type: 'UUID' }, { transaction: 't1' });

    expect(qi.describeTable).toHaveBeenCalledWith('chantiers', { transaction: 't1' });
    expect(qi.addColumn).toHaveBeenCalledWith('chantiers', 'demandeur_id', { type: 'UUID' }, { transaction: 't1' });
  });
});

describe('addIndex', () => {
  it('nomme un index anonyme comme Sequelize le ferait', () => {
    expect(nomIndexParDefaut('reserves', ['chantier_id', 'statut'])).toBe('reserves_chantier_id_statut');
    expect(nomIndexParDefaut('reserves', [{ name: 'createdAt' }])).toBe('reserves_createdat');
  });

  it('signature (table, champs) : n’indexe pas deux fois', async () => {
    const qi = queryInterface({ index: ['reserves_chantier_id_statut'] });

    await idempotent(qi).addIndex('reserves', ['chantier_id', 'statut']);

    expect(qi.addIndex).not.toHaveBeenCalled();
  });

  it('signature (table, champs) : crée l’index sous un nom EXPLICITE', async () => {
    // Le nom est posé explicitement : sans lui, un second passage ne saurait
    // pas le retrouver pour constater qu'il existe.
    const qi = queryInterface();

    await idempotent(qi).addIndex('reserves', ['chantier_id', 'statut'], { unique: false });

    expect(qi.addIndex).toHaveBeenCalledWith('reserves', {
      unique: false, fields: ['chantier_id', 'statut'], name: 'reserves_chantier_id_statut',
    });
  });

  it('signature (table, options) : respecte le nom fourni', async () => {
    const qi = queryInterface({ index: ['idx_abonnement_actif_unique'] });

    await idempotent(qi).addIndex('abonnements_souscrits', {
      fields: ['organisation_id'], name: 'idx_abonnement_actif_unique', unique: true,
    });

    expect(qi.addIndex).not.toHaveBeenCalled();
    expect(qi.sequelize.query.mock.calls[0][1].replacements).toEqual({ nom: 'idx_abonnement_actif_unique' });
  });
});

describe('le reste de l’interface', () => {
  it('passe tel quel, lié à l’objet d’origine', async () => {
    const qi = queryInterface();

    const retour = await idempotent(qi).removeColumn('plans', 'ancien');

    expect(qi.removeColumn).toHaveBeenCalledWith('plans', 'ancien');
    expect(retour).toBe(qi);
  });
});
