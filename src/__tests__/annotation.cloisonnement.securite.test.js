'use strict';

/**
 * Tests — une annotation d'une autre organisation ne se modifie ni ne se
 * supprime (IDOR inter-organisations).
 *
 * ## Le défaut
 *
 * `PUT` et `DELETE /annotations/:annotationId` chargeaient l'annotation avec
 * un include `Plan → Chantier (where organisationId)` dont le premier niveau
 * n'était PAS `required`. Sequelize produit alors :
 *
 *     annotations LEFT OUTER JOIN (plans INNER JOIN chantiers … org = X)
 *
 * Le filtre d'organisation ne s'applique qu'à la jointure : l'annotation
 * revient TOUJOURS, avec `plan = null`, et le service — qui ne testait que
 * `!annotation` — la modifiait ou la supprimait.
 *
 * ## Comment ces tests le reproduisent sans base
 *
 * `findByPk` est doublé par une ÉMULATION de cette sémantique SQL : pour une
 * annotation dont le chantier appartient à une autre organisation, une
 * jointure interne (`required: true`) ne ramène rien, une jointure externe
 * ramène la ligne avec une association vide. C'est exactement ce que fait
 * PostgreSQL ; le test échoue donc sur l'ancien code et passe sur le nouveau.
 */

jest.mock('../models/index.js', () => ({
  Annotation: { findByPk: jest.fn(), create: jest.fn(), findAll: jest.fn() },
  Plan: { findByPk: jest.fn() },
  Chantier: {},
  Utilisateur: {},
}));

const { Annotation } = require('../models/index.js');
const AnnotationService = require('../modules/plan/service/annotation.service.js');

/** Annotation posée sur un plan de l'organisation B. */
function annotationDeB() {
  return { id: 'annot-B', plan: null, update: jest.fn(), destroy: jest.fn() };
}

/** Sémantique SQL de l'include : interne → rien ; externe → ligne, association nulle. */
function emulerJointure(ligne) {
  return async (_id, options) => {
    const plan = options.include[0];
    const chantier = plan.include[0];
    const interne = plan.required === true && chantier.required !== false;
    return interne ? null : ligne;
  };
}

describe('organisation A face à une annotation de B', () => {
  it('ne peut pas la modifier', async () => {
    const cible = annotationDeB();
    Annotation.findByPk.mockImplementation(emulerJointure(cible));

    const r = await AnnotationService.modifierAnnotation('org-A', 'annot-B', { donnees: { texte: 'piraté' } });

    expect(r.success).toBe(false);
    expect(cible.update).not.toHaveBeenCalled();
  });

  it('ne peut pas la supprimer', async () => {
    const cible = annotationDeB();
    Annotation.findByPk.mockImplementation(emulerJointure(cible));

    const r = await AnnotationService.supprimerAnnotation('org-A', 'annot-B');

    expect(r.success).toBe(false);
    expect(cible.destroy).not.toHaveBeenCalled();
  });

  it('le filtre d’organisation porte bien sur le chantier du plan', async () => {
    Annotation.findByPk.mockResolvedValue(null);

    await AnnotationService.modifierAnnotation('org-A', 'annot-B', {});

    const [, options] = Annotation.findByPk.mock.calls[0];
    expect(options.include[0].required).toBe(true);
    expect(options.include[0].include[0].where).toEqual({ organisationId: 'org-A' });
  });
});

describe('dans sa propre organisation — non-régression', () => {
  it('modifie son annotation', async () => {
    const sienne = { id: 'annot-A', plan: { id: 'p' }, update: jest.fn(), destroy: jest.fn() };
    Annotation.findByPk.mockResolvedValue(sienne);

    const r = await AnnotationService.modifierAnnotation('org-A', 'annot-A', { x: 10 });

    expect(r.success).toBe(true);
    expect(sienne.update).toHaveBeenCalledWith({ x: 10 });
  });
});
