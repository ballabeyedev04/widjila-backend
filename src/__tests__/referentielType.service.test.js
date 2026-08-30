'use strict';

/**
 * Tests — service générique des référentiels de TYPE.
 *
 * Il remplace trois colonnes `ENUM` que le client ne pouvait pas étendre.
 * Ce qui doit être verrouillé :
 *
 *   1. VISIBILITÉ — le standard + le sien, jamais celui d'un autre client ;
 *   2. ÉCRITURE   — le catalogue standard n'appartient qu'au super-admin, et
 *                   nul ne modifie le référentiel d'une autre organisation ;
 *   3. CODE FIGÉ  — il est écrit dans les données ; le changer orphelinerait
 *                   les enregistrements déjà classés ;
 *   4. SUPPRESSION— refusée tant qu'un enregistrement porte le code, avec le
 *                   nombre, pour orienter vers la désactivation ;
 *   5. VALIDITÉ   — `codeValide` remplace `Joi.valid(...ENUM)` et ne doit
 *                   accepter qu'un code ACTIF et VISIBLE.
 */

const { Op, UniqueConstraintError } = require('sequelize');
const ReferentielTypeService = require('../modules/referentiel/service/referentielType.service.js');

const ORG = 'org-1';
const AUTRE_ORG = 'org-2';

/** Modèle simulé — on n'observe que les requêtes construites. */
const modele = () => ({
  findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
  findAll: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findByPk: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
});

const usage = () => ({ count: jest.fn().mockResolvedValue(0) });

function service(surcharge = {}) {
  return new ReferentielTypeService({
    modele: surcharge.modele || modele(),
    modeleUsage: surcharge.modeleUsage || usage(),
    colonneUsage: 'type',
    libelle: 'type de document',
    libelleAccord: 'Ce type de document',
  });
}

/** Ligne du référentiel, avec ses méthodes d'instance simulées. */
const ligne = (extra = {}) => ({
  id: 'type-1',
  organisationId: ORG,
  code: 'ppsps',
  nom: 'PPSPS',
  actif: true,
  update: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe('visibilité', () => {
  it('montre le standard ET les types de l’organisation', async () => {
    const m = modele();
    await service({ modele: m }).lister(ORG);

    const where = m.findAndCountAll.mock.calls[0][0].where;
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });

  it('ne montre QUE le standard à un compte sans organisation', async () => {
    const m = modele();
    await service({ modele: m }).lister(null);

    expect(m.findAndCountAll.mock.calls[0][0].where).toEqual({ organisationId: null });
  });

  it('la recherche n’écrase pas le filtre de visibilité', async () => {
    // Réécrire `where[Op.or]` ferait remonter les types des autres clients :
    // le service doit passer par `Op.and`.
    const m = modele();
    await service({ modele: m }).lister(ORG, { search: 'ppsps' });

    const where = m.findAndCountAll.mock.calls[0][0].where;
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
    expect(where[Op.and]).toHaveLength(1);
  });

  it('le super-admin voit tout', async () => {
    const m = modele();
    await service({ modele: m }).lister(ORG, {}, { toutesOrganisations: true });

    expect(m.findAndCountAll.mock.calls[0][0].where).toEqual({});
  });

  it('ne propose que les types ACTIFS aux listes déroulantes', async () => {
    const m = modele();
    await service({ modele: m }).listerActifs(ORG);

    expect(m.findAll.mock.calls[0][0].where.actif).toBe(true);
  });
});

describe('écriture', () => {
  it('refuse de modifier le catalogue standard', async () => {
    const m = modele();
    m.findByPk.mockResolvedValue(ligne({ organisationId: null }));

    const res = await service({ modele: m }).modifier(ORG, 'type-1', { nom: 'Autre' });

    expect(res.success).toBe(false);
    expect(res.message).toContain('catalogue standard');
  });

  it('refuse de modifier le référentiel d’une AUTRE organisation', async () => {
    const m = modele();
    m.findByPk.mockResolvedValue(ligne({ organisationId: AUTRE_ORG }));

    const res = await service({ modele: m }).modifier(ORG, 'type-1', { nom: 'Autre' });

    expect(res.success).toBe(false);
    // Même message que « introuvable » : dire « appartient à une autre
    // organisation » confirmerait son existence.
    expect(res.message).toContain('introuvable');
  });

  it('laisse le super-admin modifier le catalogue standard', async () => {
    const m = modele();
    const l = ligne({ organisationId: null });
    m.findByPk.mockResolvedValue(l);

    const res = await service({ modele: m }).modifier(ORG, 'type-1', { nom: 'Plan général' }, { superAdmin: true });

    expect(res.success).toBe(true);
    expect(l.update).toHaveBeenCalledWith({ nom: 'Plan général' });
  });

  it('crée dans SA propre organisation, quoi que demande le client', async () => {
    const m = modele();
    m.create.mockResolvedValue(ligne());

    await service({ modele: m }).creer(ORG, { code: 'ppsps', nom: 'PPSPS', organisationId: AUTRE_ORG });

    // `organisationId` du corps de requête est ignoré hors super-admin :
    // sinon n'importe qui écrirait dans le catalogue d'un autre client.
    expect(m.create.mock.calls[0][0].organisationId).toBe(ORG);
  });

  it('normalise le code en minuscules', async () => {
    const m = modele();
    m.create.mockResolvedValue(ligne());

    await service({ modele: m }).creer(ORG, { code: '  PPSPS  ', nom: 'PPSPS' });

    // La colonne métier stockera cette valeur, et les comparaisons du code
    // applicatif sont sensibles à la casse.
    expect(m.create.mock.calls[0][0].code).toBe('ppsps');
  });

  it('traduit une collision d’unicité en message métier', async () => {
    const m = modele();
    m.create.mockRejectedValue(new UniqueConstraintError({}));

    const res = await service({ modele: m }).creer(ORG, { code: 'plan', nom: 'Plan' });

    expect(res.success).toBe(false);
    expect(res.message).toContain('déjà ce code');
  });
});

describe('le code est figé', () => {
  it('refuse de changer le code d’un type existant', async () => {
    const m = modele();
    m.findByPk.mockResolvedValue(ligne({ code: 'ppsps' }));

    const res = await service({ modele: m }).modifier(ORG, 'type-1', { code: 'autre_code' });

    expect(res.success).toBe(false);
    expect(res.message).toContain('ne peut pas être modifié');
  });

  it('accepte le MÊME code renvoyé tel quel', async () => {
    // Un formulaire qui repostera tout l'objet ne doit pas échouer.
    const m = modele();
    const l = ligne({ code: 'ppsps' });
    m.findByPk.mockResolvedValue(l);

    const res = await service({ modele: m }).modifier(ORG, 'type-1', { code: 'PPSPS', nom: 'PPSPS v2' });

    expect(res.success).toBe(true);
    expect(l.update).toHaveBeenCalledWith({ nom: 'PPSPS v2' });
  });
});

describe('suppression', () => {
  it('refuse quand des enregistrements portent le code, et les compte', async () => {
    const m = modele();
    m.findByPk.mockResolvedValue(ligne());
    const u = usage();
    u.count.mockResolvedValue(4);

    const res = await service({ modele: m, modeleUsage: u }).supprimer(ORG, 'type-1');

    expect(res.success).toBe(false);
    expect(res.message).toContain('4');
    // Le message doit ORIENTER : sans cela l'utilisateur reste bloqué.
    expect(res.message).toContain('Désactivez');
    expect(u.count.mock.calls[0][0].where.type).toBe('ppsps');
  });

  it('accorde le singulier à un seul usage', async () => {
    const m = modele();
    m.findByPk.mockResolvedValue(ligne());
    const u = usage();
    u.count.mockResolvedValue(1);

    const res = await service({ modele: m, modeleUsage: u }).supprimer(ORG, 'type-1');

    expect(res.message).toContain('1 enregistrement utilise');
  });

  it('supprime quand plus rien ne l’utilise', async () => {
    const m = modele();
    const l = ligne();
    m.findByPk.mockResolvedValue(l);

    const res = await service({ modele: m }).supprimer(ORG, 'type-1');

    expect(res.success).toBe(true);
    expect(l.destroy).toHaveBeenCalled();
  });

  it('désactiver ne touche à AUCUN enregistrement', async () => {
    const m = modele();
    const l = ligne();
    m.findByPk.mockResolvedValue(l);
    const u = usage();

    await service({ modele: m, modeleUsage: u }).basculerActif(ORG, 'type-1', false);

    expect(l.update).toHaveBeenCalledWith({ actif: false });
    // C'est tout l'intérêt de la désactivation : les documents déjà classés
    // gardent leur type et leur libellé.
    expect(u.count).not.toHaveBeenCalled();
  });
});

describe('codeValide — remplace Joi.valid(...ENUM)', () => {
  it('accepte un code actif et visible', async () => {
    const m = modele();
    m.findOne.mockResolvedValue({ id: 'type-1' });

    expect(await service({ modele: m }).codeValide(ORG, 'ppsps')).toBe(true);
  });

  it('refuse un code inconnu', async () => {
    expect(await service().codeValide(ORG, 'inexistant')).toBe(false);
  });

  it('refuse une valeur vide sans interroger la base', async () => {
    const m = modele();

    expect(await service({ modele: m }).codeValide(ORG, '')).toBe(false);
    expect(m.findOne).not.toHaveBeenCalled();
  });

  it('n’interroge que les types ACTIFS et visibles', async () => {
    const m = modele();
    m.findOne.mockResolvedValue({ id: 'type-1' });

    await service({ modele: m }).codeValide(ORG, 'PPSPS');

    const where = m.findOne.mock.calls[0][0].where;
    expect(where.actif).toBe(true);
    // Comparaison en minuscules : la colonne stocke le code normalisé.
    expect(where.code).toBe('ppsps');
    expect(where[Op.or]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });
});
