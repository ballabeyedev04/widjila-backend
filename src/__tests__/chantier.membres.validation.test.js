'use strict';

/**
 * Tests — affectation de membres à un chantier.
 *
 * `POST /chantiers/:id/membres` n'avait aucun schéma : un `membreIds` absent,
 * une chaîne au lieu d'une liste, ou une liste avec doublons atteignaient le
 * service tels quels — le dernier cas faisait refuser l'affectation avec un
 * message faux (« certains membres ne font pas partie de cette organisation »).
 */

const { assignerMembresSchema } = require('../modules/chantier/validation/chantier.validation.js');

const ID_1 = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ID_2 = '7a2b3c4d-5e6f-4a70-8b8c-0d1e2f3a4b5c';

describe('assignerMembresSchema', () => {
  test('accepte une liste d’identifiants, avec ou sans rôle sur le chantier', () => {
    expect(assignerMembresSchema.validate({ membreIds: [ID_1, ID_2] }).error).toBeUndefined();
    expect(assignerMembresSchema.validate({ membreIds: [ID_1], roleChantier: 'Responsable lot 2' }).error).toBeUndefined();
  });

  test('refuse une liste absente ou vide', () => {
    expect(assignerMembresSchema.validate({}).error).toBeDefined();
    expect(assignerMembresSchema.validate({ membreIds: [] }).error).toBeDefined();
  });

  test('refuse un doublon et un identifiant mal formé', () => {
    expect(assignerMembresSchema.validate({ membreIds: [ID_1, ID_1] }).error).toBeDefined();
    expect(assignerMembresSchema.validate({ membreIds: ['pas-un-uuid'] }).error).toBeDefined();
  });

  test('refuse un rôle plus long que la colonne (50 caractères)', () => {
    expect(assignerMembresSchema.validate({ membreIds: [ID_1], roleChantier: 'x'.repeat(51) }).error).toBeDefined();
  });
});
