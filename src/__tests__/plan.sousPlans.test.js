'use strict';

/**
 * Tests — les sous-plans, ou « un plan de détail dans un plan ».
 *
 * ## Le besoin
 *
 * La hiérarchie des plans vient de la STRUCTURE du chantier — bâtiment, étage,
 * zone — et s'arrête donc à l'appartement. Le client a confirmé le besoin
 * d'aller plus bas : le plan d'une pièce, d'un local technique ou d'une
 * façade, ouvert depuis le plan de l'appartement, avec ses propres réserves.
 *
 * ## Le piège évité
 *
 * `parentId` pourrait devenir une SECONDE hiérarchie, concurrente de la
 * structure. Deux places contradictoires pour un même plan seraient ensuite
 * impossibles à arbitrer, et les rapports comme les filtres — qui reposent sur
 * `batimentId` / `etageId` / `zoneId` — deviendraient faux.
 *
 * La règle qui l'empêche, et que ces tests verrouillent : **un plan de détail
 * HÉRITE de la place de son parent**, et le rattachement éventuellement envoyé
 * à côté est ignoré. La structure reste la seule source de vérité pour « dans
 * quel bâtiment, à quel étage » ; `parentId` ne fait qu'affiner à l'intérieur.
 */

/**
 * La connexion est doublée : depuis que la liste des sous-plans porte ses
 * compteurs (« combien de sous-plans, combien de réserves »), le service pose
 * deux agrégats SQL. Sans ce double, le test irait chercher une vraie base.
 *
 * `[]` — aucun enfant, aucune réserve : les compteurs valent 0, ce qui est le
 * cas de la feuille d'arborescence, le plus fréquent.
 */
jest.mock('../config/db.js', () => ({
  query: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
}));

jest.mock('../models/index.js', () => ({
  Plan: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), max: jest.fn() },
  Chantier: { findOne: jest.fn() },
  Batiment: { findOne: jest.fn(), findByPk: jest.fn() },
  Etage: { findByPk: jest.fn() },
  Zone: { findByPk: jest.fn() },
  Reserve: {},
  PlanHotspot: {},
  Annotation: {},
  Media: {},
}));

const { Plan, Chantier } = require('../models/index.js');
const PlanService = require('../modules/plan/service/plan.service.js');
const { uploadPlanSchema } = require('../modules/plan/validation/plan.validation.js');

const ORG = 'org-1';
const CHANTIER = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => jest.clearAllMocks());

describe('le schéma accepte un plan parent', () => {
  const base = { chantierId: CHANTIER, nom: 'Cuisine — détail' };

  it('accepte un `parentId`', () => {
    expect(uploadPlanSchema.validate({ ...base, parentId: PARENT }).error).toBeUndefined();
  });

  it('reste facultatif — la quasi-totalité des plans n’en a pas', () => {
    expect(uploadPlanSchema.validate(base).error).toBeUndefined();
  });

  it('refuse un identifiant qui n’est pas un UUID', () => {
    expect(uploadPlanSchema.validate({ ...base, parentId: 'A1' }).error).toBeDefined();
  });
});

describe('un plan de détail hérite de la place de son parent', () => {
  /** Le parent, tel qu'il est en base : rattaché à un appartement. */
  const parentEnBase = {
    id: PARENT,
    batimentId: 'bat-1',
    etageId: 'etage-1',
    zoneId: 'zone-1',
  };

  it('reprend bâtiment, étage et zone du parent', async () => {
    Plan.findOne.mockResolvedValue(parentEnBase);

    const r = await PlanService._resoudreRattachement(CHANTIER, { parentId: PARENT });

    expect(r).toEqual({
      parentId: PARENT,
      batimentId: 'bat-1',
      etageId: 'etage-1',
      zoneId: 'zone-1',
    });
  });

  it('IGNORE un rattachement envoyé à côté du parent', async () => {
    // C'est la garde qui empêche les deux hiérarchies de diverger : le client
    // ne peut pas déclarer un plan « détail de l'appartement A203 » ET
    // « rattaché au bâtiment B ».
    Plan.findOne.mockResolvedValue(parentEnBase);

    const r = await PlanService._resoudreRattachement(CHANTIER, {
      parentId: PARENT,
      batimentId: 'bat-AUTRE',
      etageId: 'etage-AUTRE',
      zoneId: 'zone-AUTRE',
    });

    expect(r.batimentId).toBe('bat-1');
    expect(r.etageId).toBe('etage-1');
    expect(r.zoneId).toBe('zone-1');
  });

  it('hérite aussi d’un parent GLOBAL — sans rattachement', async () => {
    // Le détail d'un plan de masse est lui-même sans bâtiment : il n'invente
    // pas une place que son parent n'a pas.
    Plan.findOne.mockResolvedValue({ id: PARENT, batimentId: null, etageId: null, zoneId: null });

    const r = await PlanService._resoudreRattachement(CHANTIER, { parentId: PARENT });

    expect(r).toEqual({ parentId: PARENT, batimentId: null, etageId: null, zoneId: null });
  });

  it('refuse un parent qui appartient à un AUTRE chantier', async () => {
    // La requête porte `chantierId` : un parent d'ailleurs ne remonte pas.
    Plan.findOne.mockResolvedValue(null);

    const r = await PlanService._resoudreRattachement(CHANTIER, { parentId: PARENT });

    expect(r.erreur).toEqual(expect.stringContaining('parent'));
    expect(Plan.findOne.mock.calls[0][0].where).toEqual({ id: PARENT, chantierId: CHANTIER });
  });
});

describe('un plan sans parent garde le comportement d’avant', () => {
  it('un plan global reste global, et sans parent', async () => {
    const r = await PlanService._resoudreRattachement(CHANTIER, {});

    expect(r).toEqual({ parentId: null, batimentId: null, etageId: null, zoneId: null });
    // Aucune requête inutile quand il n'y a pas de parent à résoudre.
    expect(Plan.findOne).not.toHaveBeenCalled();
  });
});

describe('les sous-plans directs', () => {
  it('ne renvoie que les enfants DIRECTS du plan ouvert', async () => {
    // La navigation est progressive : renvoyer l'arborescence entière
    // obligerait le client à la filtrer et ferait grossir la réponse de plans
    // que personne ne regarde encore.
    Plan.findOne.mockResolvedValue({ id: PARENT, chantierId: CHANTIER });
    Plan.findAll.mockResolvedValue([{ id: 'enfant-1', chantierId: CHANTIER, nom: 'Cuisine', dataValues: {} }]);

    const r = await PlanService.listSousPlans(ORG, PARENT);

    expect(r.success).toBe(true);
    expect(Plan.findAll.mock.calls[0][0].where).toEqual({ parentId: PARENT });
  });

  it('annonce, pour chaque enfant, s’il mène plus bas et ce qu’il porte', async () => {
    // C'est ce qui rend la navigation par niveau tenable : le client ne charge
    // qu'un cran d'arborescence à la fois, il ne peut donc pas DÉDUIRE d'une
    // liste locale qu'une tuile a des enfants. Sans ces compteurs, il faudrait
    // ouvrir chaque plan pour l'apprendre.
    Plan.findOne.mockResolvedValue({ id: PARENT, chantierId: CHANTIER });
    Plan.findAll.mockResolvedValue([{ id: 'enfant-1', chantierId: CHANTIER, nom: 'Cuisine', dataValues: {} }]);

    const r = await PlanService.listSousPlans(ORG, PARENT);

    expect(r.sousPlans[0].dataValues.nombre_sous_plans).toBe(0);
    expect(r.sousPlans[0].dataValues.nombre_reserves).toBe(0);
  });

  it('ne garde qu’UNE version par plan — la plus récente', async () => {
    // Un plan redéposé trois fois apparaîtrait trois fois dans la même liste,
    // sans qu'aucune des trois tuiles ne dise laquelle est la bonne.
    // La requête trie déjà par (nom ASC, version DESC) : la première gagne.
    Plan.findOne.mockResolvedValue({ id: PARENT, chantierId: CHANTIER });
    Plan.findAll.mockResolvedValue([
      { id: 'v3', chantierId: CHANTIER, nom: 'Cuisine', version: 3, dataValues: {} },
      { id: 'v2', chantierId: CHANTIER, nom: 'Cuisine', version: 2, dataValues: {} },
      { id: 'sdb', chantierId: CHANTIER, nom: 'Salle de bain', version: 1, dataValues: {} },
    ]);

    const r = await PlanService.listSousPlans(ORG, PARENT);

    expect(r.sousPlans.map((p) => p.id)).toEqual(['v3', 'sdb']);
  });

  it('vérifie l’organisation par le PARENT, jamais par le paramètre reçu', async () => {
    Plan.findOne.mockResolvedValue({ id: PARENT, chantierId: CHANTIER });
    Plan.findAll.mockResolvedValue([]);

    await PlanService.listSousPlans(ORG, PARENT);

    // Le cloisonnement passe par une jointure obligatoire sur le chantier :
    // un identifiant deviné ne donne pas les plans d'un autre client.
    const include = Plan.findOne.mock.calls[0][0].include[0];
    expect(include.where).toEqual({ organisationId: ORG });
    expect(include.required).toBe(true);
  });

  it('refuse un plan hors de l’organisation', async () => {
    Plan.findOne.mockResolvedValue(null);

    const r = await PlanService.listSousPlans(ORG, PARENT);

    expect(r.success).toBe(false);
    // Et surtout : aucune liste n'est chargée avant le refus.
    expect(Plan.findAll).not.toHaveBeenCalled();
  });

  it('rend une liste vide pour un plan sans détail — ce n’est pas une erreur', async () => {
    // Un plan sans sous-plan est une feuille : c'est le cas le plus courant.
    Plan.findOne.mockResolvedValue({ id: PARENT, chantierId: CHANTIER });
    Plan.findAll.mockResolvedValue([]);

    const r = await PlanService.listSousPlans(ORG, PARENT);

    expect(r.success).toBe(true);
    expect(r.sousPlans).toEqual([]);
  });
});

describe('les plans GLOBAUX du chantier', () => {
  /**
   * Le point d'entrée du parcours de relevé.
   *
   * `listPlans` renvoie l'arborescence à plat — plans globaux, plans de
   * bâtiment, plans d'étage et plans de détail mélangés. C'est ce qu'il faut à
   * l'écran « tous les documents », et exactement ce qu'il ne faut pas ici :
   * l'utilisateur doit descendre un cran à la fois.
   */
  it('ne renvoie QUE les plans sans parent', async () => {
    Chantier.findOne.mockResolvedValue({ id: CHANTIER });
    Plan.findAll.mockResolvedValue([{ id: 'global-1', chantierId: CHANTIER, nom: 'Masse', dataValues: {} }]);

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.success).toBe(true);
    expect(Plan.findAll.mock.calls[0][0].where).toEqual({ chantierId: CHANTIER, parentId: null });
  });

  it('refuse un chantier hors de l’organisation, sans charger de plan', async () => {
    Chantier.findOne.mockResolvedValue(null);

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.success).toBe(false);
    expect(Plan.findAll).not.toHaveBeenCalled();
  });

  it('porte les mêmes compteurs que les sous-plans', async () => {
    // Les deux routes renvoient la même forme d'objet : le client n'a qu'un
    // seul rendu de tuile à écrire, quel que soit le niveau où il se trouve.
    Chantier.findOne.mockResolvedValue({ id: CHANTIER });
    Plan.findAll.mockResolvedValue([{ id: 'global-1', chantierId: CHANTIER, nom: 'Masse', dataValues: {} }]);

    const r = await PlanService.listPlansRacines(ORG, CHANTIER);

    expect(r.plans[0].dataValues).toEqual(
      expect.objectContaining({ nombre_sous_plans: 0, nombre_reserves: 0 })
    );
  });
});

describe('la relation en base', () => {
  it('la migration pose bien SET NULL, et non CASCADE', () => {
    // Le modèle est `paranoid` : ce comportement ne joue qu'en cas de
    // suppression PHYSIQUE. CASCADE emporterait alors les plans de détail avec
    // toutes les réserves relevées dessus, sans que personne l'ait demandé.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'migrations', '20260907000001-plan-sous-plans.js'),
      'utf8'
    );

    expect(source).toContain("onDelete: 'SET NULL'");
    expect(source).not.toContain("onDelete: 'CASCADE'");
    // Et un index : la question « quels sont ses enfants ? » est posée à
    // chaque ouverture d'un plan.
    expect(source).toContain("addIndex('plans', ['parent_id']");
  });
});

