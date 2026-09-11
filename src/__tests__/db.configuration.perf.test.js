'use strict';

/**
 * Tests — les délais de la base parviennent réellement au pilote PostgreSQL.
 *
 * `db.js` déclarait `connectTimeout: 10000`. Ce n'est pas une option du
 * pilote `pg`, et Sequelize ne transmet de `dialectOptions` qu'une liste
 * FERMÉE de clés : l'option était jetée en silence. La base tournait donc
 * sans aucun délai de connexion, de requête ni de transaction inactive, et
 * attendait 30 s avant de déclarer le pool saturé.
 *
 * Le test lit la liste de Sequelize dans la bibliothèque installée : si une
 * mise à jour la change, il le dira au lieu de laisser un réglage redevenir
 * lettre morte.
 */

const fs = require('fs');
const path = require('path');
const sequelize = require('../config/db.js');

const SOURCE_SEQUELIZE = fs.readFileSync(
  path.join(path.dirname(require.resolve('sequelize')), 'dialects', 'postgres', 'connection-manager.js'),
  'utf8'
);

/** Clés de `dialectOptions` que Sequelize transmet à `pg`. */
const CLES_TRANSMISES = (() => {
  const bloc = SOURCE_SEQUELIZE.match(/_\.pick\(config\.dialectOptions,\s*\[([\s\S]*?)\]\)/);
  if (!bloc) throw new Error('Liste des options transmises introuvable dans Sequelize');
  return [...bloc[1].matchAll(/["']([a-zA-Z_]+)["']/g)].map((m) => m[1]);
})();

afterAll(() => sequelize.close());

describe('config/db.js', () => {
  const { dialectOptions, pool } = sequelize.options;

  it.each(['connectionTimeoutMillis', 'statement_timeout', 'idle_in_transaction_session_timeout'])(
    '%s est posé ET transmis au pilote',
    (cle) => {
      expect(typeof dialectOptions[cle]).toBe('number');
      expect(dialectOptions[cle]).toBeGreaterThan(0);
      expect(CLES_TRANSMISES).toContain(cle);
    }
  );

  it('ne déclare plus d’option que Sequelize jetterait', () => {
    const ignorees = Object.keys(dialectOptions).filter((c) => c !== 'ssl' && !CLES_TRANSMISES.includes(c));
    expect(ignorees).toEqual([]);
  });

  it('la saturation du pool se déclare en 10 s, pas en 30', () => {
    expect(pool.acquire).toBeLessThanOrEqual(10000);
  });

  it('les délais par défaut restent au-dessus d’une requête légitime', () => {
    // Un délai trop court tuerait les exports et les purges nocturnes.
    expect(dialectOptions.statement_timeout).toBeGreaterThanOrEqual(15000);
    expect(dialectOptions.idle_in_transaction_session_timeout).toBeGreaterThan(dialectOptions.statement_timeout);
  });
});

describe('server.js — délais HTTP', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('le keep-alive de Node dépasse celui de nginx (60 s)', () => {
    const valeur = Number((source.match(/keepAliveTimeout:\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''));
    expect(valeur).toBeGreaterThan(60000);
  });

  it('headersTimeout > keepAliveTimeout (exigence de Node)', () => {
    const lire = (cle) => Number((source.match(new RegExp(`${cle}:\\s*([\\d_]+)`)) || [])[1]?.replace(/_/g, ''));
    expect(lire('headersTimeout')).toBeGreaterThan(lire('keepAliveTimeout'));
  });

  it('les délais sont appliqués au serveur démarré', () => {
    expect(source).toMatch(/appliquerDelaisHttp\(server\)/);
  });
});
