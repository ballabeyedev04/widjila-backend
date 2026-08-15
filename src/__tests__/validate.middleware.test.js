'use strict';

/**
 * Tests — middlewares/validate.middleware.js (audit — Cohérence API back/admin
 * §7). Couvre les deux garanties attendues :
 *   1. un payload invalide produit bien une ValidationError (422) ;
 *   2. le filet anti-désynchronisation (`signalerChampsIgnores`) journalise
 *      les champs silencieusement retirés par `stripUnknown` — Y COMPRIS EN
 *      PRODUCTION depuis le correctif de cet audit (il ne tournait qu'en dev
 *      auparavant, désynchronisant silencieusement API et client en prod).
 */

const Joi = require('joi');

jest.mock('../utils/logger.js', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../utils/logger.js');
const validate = require('../middlewares/validate.middleware.js');

const schema = Joi.object({
  titre: Joi.string().min(2).required(),
  date_debut: Joi.date().iso().optional(),
});

function run(body) {
  const req = { method: 'POST', originalUrl: '/api/v1/chantiers', body };
  const next = jest.fn();
  validate(schema)(req, {}, next);
  return { req, next };
}

describe('validate.middleware', () => {
  const ENV_BASE = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = ENV_BASE; });

  test('body valide : req.body est remplacé par la valeur nettoyée, next() sans erreur', () => {
    const { req, next } = run({ titre: 'Chantier A', date_debut: '2026-01-01' });
    expect(next).toHaveBeenCalledWith();
    expect(req.body.titre).toBe('Chantier A');
  });

  test('body invalide : next(ValidationError) avec le détail des messages Joi', () => {
    const { next } = run({ titre: 'x' }); // trop court (min 2)
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.details?.length || err.message).toBeTruthy();
  });

  test('un champ inconnu déclenche un avertissement (dev)', () => {
    process.env.NODE_ENV = 'development';
    run({ titre: 'Chantier A', dateDebut: '2026-01-01' }); // faute de frappe : camelCase au lieu de snake_case
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/dateDebut/);
  });

  // Correctif de l'audit : ce garde-fou tournait auparavant UNIQUEMENT hors
  // production (`if (!isProd)`) — désynchronisant silencieusement API et
  // client en prod, l'environnement où c'est le plus coûteux à diagnostiquer.
  test('un champ inconnu déclenche AUSSI un avertissement en production', () => {
    process.env.NODE_ENV = 'production';
    run({ titre: 'Chantier A', dateDebut: '2026-01-01' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('aucun avertissement si tous les champs reçus sont dans le schéma', () => {
    process.env.NODE_ENV = 'development';
    run({ titre: 'Chantier A' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('le champ __proto__ est ignoré silencieusement (pas un vrai champ métier)', () => {
    process.env.NODE_ENV = 'development';
    // `{ titre: 'x', __proto__: {...} }` en littéral d'objet définit le
    // PROTOTYPE (pas une propriété propre) : on passe par JSON.parse pour
    // obtenir une vraie propriété propre "__proto__", comme le ferait un
    // body JSON reçu d'un client.
    const body = JSON.parse('{"titre":"Chantier A","__proto__":{"hack":true}}');
    run(body);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
