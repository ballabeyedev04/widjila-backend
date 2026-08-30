'use strict';

/**
 * Tests — modules/phase/service/phaseReferentiel.service.js
 *
 * Le référentiel des phases (Pré-cloisons, Cloisons, OPR…) partage sa table
 * avec les phases de PLANNING d'un chantier. Ce qui doit être verrouillé :
 *
 *   1. CLOISONNEMENT — le service ne touche jamais une phase de planning
 *      (`chantierId` renseigné), et le planning ne voit jamais le référentiel ;
 *   2. HISTORIQUE    — une phase utilisée par des réserves ne peut pas être
 *      supprimée ; désactiver ne modifie AUCUNE réserve ;
 *   3. VISIBILITÉ    — le standard + le sien, jamais celui d'un autre ;
 *   4. ÉCRITURE      — le référentiel standard n'appartient qu'au super-admin.
 */

jest.mock('../models/index.js', () => ({
  Phase: {
    findAndCountAll: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
  },
  Reserve: { count: jest.fn() },
}));

const { Op, UniqueConstraintError } = require('sequelize');
const { Phase, Reserve } = require('../models/index.js');
const PhaseReferentielService = require('../modules/phase/service/phaseReferentiel.service.js');

const ORG = 'org-1';
const AUTRE_ORG = 'org-2';
const ID = 'phase-1';

const ligne = (extra = {}) => ({
  id: ID,
  chantierId: null,
  organisationId: ORG,
  nom: 'OPR',
  destroy: jest.fn().mockResolvedValue(),
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

/** Aplatit un `where` Sequelize (symboles compris) en objet lisible. */
const decrire = (valeur) => {
  if (Array.isArray(valeur)) return valeur.map(decrire);
  if (valeur && typeof valeur === 'object') {
    const sortie = {};
    for (const cle of Object.keys(valeur)) sortie[cle] = decrire(valeur[cle]);
    for (const sy of Object.getOwnPropertySymbols(valeur)) sortie[sy.toString()] = decrire(valeur[sy]);
    return sortie;
  }
  return valeur;
};

beforeEach(() => {
  jest.clearAllMocks();
  Phase.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
  Phase.findAll.mockResolvedValue([]);
  Reserve.count.mockResolvedValue(0);
});

describe('cloisonnement référentiel / planning', () => {
  it('toute lecture est restreinte aux lignes SANS chantier', async () => {
    // Sans ce filtre, la liste du référentiel remonterait aussi les phases de
    // planning de tous les chantiers — « Gros œuvre » du chantier A, du
    // chantier B… — et la liste de saisie deviendrait inutilisable.
    await PhaseReferentielService.lister(ORG, {});

    const where = decrire(Phase.findAndCountAll.mock.calls[0][0].where);
    expect(where.chantierId).toBeNull();
  });

  it('refuse de modifier une phase de PLANNING via la route du référentiel', async () => {
    // Sinon cette route servirait à réécrire le calendrier d'un chantier.
    Phase.findByPk.mockResolvedValue(ligne({ chantierId: 'chantier-9' }));

    const res = await PhaseReferentielService.modifier(ORG, ID, { nom: 'X' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
  });

  it('crée toujours une ligne de référentiel, jamais de planning', async () => {
    Phase.create.mockResolvedValue(ligne());

    await PhaseReferentielService.creer(ORG, { nom: 'Pré-cloisons' });

    expect(Phase.create.mock.calls[0][0].chantierId).toBeNull();
  });
});

describe('historique — la règle centrale', () => {
  it('refuse de supprimer une phase utilisée, et invite à la désactiver', async () => {
    Phase.findByPk.mockResolvedValue(ligne());
    Reserve.count.mockResolvedValue(12);

    const res = await PhaseReferentielService.supprimer(ORG, ID);

    expect(res.success).toBe(false);
    expect(res.message).toContain('12 réserves');
    expect(res.message).toMatch(/désactivez/i);
  });

  it('accorde le singulier sur une seule réserve', async () => {
    Phase.findByPk.mockResolvedValue(ligne());
    Reserve.count.mockResolvedValue(1);

    const res = await PhaseReferentielService.supprimer(ORG, ID);

    expect(res.message).toMatch(/^1 réserve est rattachée/);
  });

  it('supprime seulement quand plus aucune réserve n’y pointe', async () => {
    const cible = ligne();
    Phase.findByPk.mockResolvedValue(cible);

    const res = await PhaseReferentielService.supprimer(ORG, ID);

    expect(res.success).toBe(true);
    expect(cible.destroy).toHaveBeenCalled();
  });

  it('désactiver ne touche à AUCUNE réserve', async () => {
    // C'est tout l'intérêt de la désactivation : la phase quitte les listes de
    // saisie, les réserves déjà rattachées gardent leur phase d'origine.
    const cible = ligne();
    Phase.findByPk.mockResolvedValue(cible);

    const res = await PhaseReferentielService.basculerActif(ORG, ID, false);

    expect(res.success).toBe(true);
    expect(cible.update).toHaveBeenCalledWith({ actif: false });
    expect(cible.destroy).not.toHaveBeenCalled();
    expect(Reserve.count).not.toHaveBeenCalled();
  });

  it('renommer ou réordonner ne touche à AUCUNE réserve', async () => {
    // Les réserves pointent sur l'identifiant, pas sur le libellé :
    // l'association historique survit au changement de nom.
    const cible = ligne();
    Phase.findByPk.mockResolvedValue(cible);

    await PhaseReferentielService.modifier(ORG, ID, { nom: 'OPR (révisé)', ordre: 45 });

    expect(cible.update).toHaveBeenCalledWith({ nom: 'OPR (révisé)', ordre: 45 });
    expect(Reserve.count).not.toHaveBeenCalled();
  });
});

describe('visibilité et propriété', () => {
  it('montre le référentiel standard ET celui de l’organisation', async () => {
    await PhaseReferentielService.lister(ORG, {});

    const where = decrire(Phase.findAndCountAll.mock.calls[0][0].where);
    expect(where[Op.or.toString()]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });

  it('la recherche n’écrase pas le filtre de visibilité', async () => {
    await PhaseReferentielService.lister(ORG, { search: 'clois' });

    const where = decrire(Phase.findAndCountAll.mock.calls[0][0].where);
    expect(where[Op.or.toString()]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
    expect(where[Op.and.toString()]).toHaveLength(1);
  });

  it('refuse de modifier une phase du référentiel standard', async () => {
    Phase.findByPk.mockResolvedValue(ligne({ organisationId: null }));

    const res = await PhaseReferentielService.modifier(ORG, ID, { nom: 'X' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/référentiel standard/i);
  });

  it('laisse le super-admin modifier le référentiel standard', async () => {
    const cible = ligne({ organisationId: null });
    Phase.findByPk.mockResolvedValue(cible);

    const res = await PhaseReferentielService.modifier(null, ID, { nom: 'OPR' }, { superAdmin: true });

    expect(res.success).toBe(true);
    expect(cible.update).toHaveBeenCalledWith({ nom: 'OPR' });
  });

  it('traite la phase d’une autre organisation comme introuvable', async () => {
    // « Introuvable » et non « interdit » : un 403 confirmerait l'existence de
    // la ligne et permettrait d'énumérer le référentiel d'un concurrent.
    Phase.findByPk.mockResolvedValue(ligne({ organisationId: AUTRE_ORG }));

    const res = await PhaseReferentielService.modifier(ORG, ID, { nom: 'X' });

    expect(res.message).toMatch(/introuvable/i);
    expect(res.message).not.toMatch(/standard/i);
  });

  it('ne compte pas les réserves avant d’avoir vérifié la propriété', async () => {
    Phase.findByPk.mockResolvedValue(ligne({ organisationId: AUTRE_ORG }));

    await PhaseReferentielService.supprimer(ORG, ID);

    expect(Reserve.count).not.toHaveBeenCalled();
  });
});

describe('ordre d’affichage', () => {
  it('trie sur `ordre`, pas sur le nom', async () => {
    // « Décennale » ne vient pas avant « Pré-cloisons » : c'est l'ordre du
    // chantier qui fait sens, et il est stocké explicitement.
    await PhaseReferentielService.listerActives(ORG);

    expect(Phase.findAll.mock.calls[0][0].order).toEqual([['ordre', 'ASC'], ['nom', 'ASC']]);
  });

  it('ne propose que les phases actives à la saisie', async () => {
    await PhaseReferentielService.listerActives(ORG);

    const where = decrire(Phase.findAll.mock.calls[0][0].where);
    expect(where.actif).toBe(true);
    expect(where.chantierId).toBeNull();
  });
});

describe('unicité', () => {
  it('traduit une collision d’index en message métier', async () => {
    Phase.create.mockRejectedValue(new UniqueConstraintError({ errors: [] }));

    const res = await PhaseReferentielService.creer(ORG, { nom: 'OPR' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/porte déjà ce nom/i);
  });

  it('laisse remonter une panne réelle au lieu de la maquiller', async () => {
    Phase.create.mockRejectedValue(new Error('connexion perdue'));

    await expect(PhaseReferentielService.creer(ORG, { nom: 'GPA' })).rejects.toThrow('connexion perdue');
  });
});
