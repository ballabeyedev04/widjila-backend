'use strict';

/**
 * Tests — modules/plan/service/hotspot.service.js.
 *
 * Les zones cliquables sont le maillon qui rend navigable le parcours du
 * guide client (plan global → bâtiment → étage → appartement). Leur cible est
 * une association POLYMORPHE (`cible_type` + `cible_id`) qu'aucune clé
 * étrangère ne peut contraindre : la seule protection est la vérification
 * applicative de `_verifierCible`. Ces tests portent donc sur ce qui casse
 * silencieusement si elle est mal faite :
 *
 *   1. l'isolation multi-tenant (un plan d'une autre organisation) ;
 *   2. la cohérence de la cible (un bâtiment d'un AUTRE chantier) ;
 *   3. la remontée de chaîne étage → bâtiment et zone → étage → bâtiment.
 *
 * Modèles Sequelize mockés — même approche que reserve.changerStatut.roles.test.js,
 * aucune base PostgreSQL requise.
 */

jest.mock('../models/index.js', () => ({
  PlanHotspot: { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  Plan: { findByPk: jest.fn() },
  Chantier: {},
  Batiment: { findOne: jest.fn(), findByPk: jest.fn() },
  Etage: { findByPk: jest.fn() },
  Zone: { findByPk: jest.fn() },
}));

const { PlanHotspot, Plan, Batiment, Etage, Zone } = require('../models/index.js');
const HotspotService = require('../modules/plan/service/hotspot.service.js');

const ORG = 'org-1';
const CHANTIER = 'chantier-1';
const PLAN = 'plan-1';

/** Plan appartenant à l'organisation testée. */
const planValide = () => ({ id: PLAN, chantierId: CHANTIER });

const donnees = (surcharge = {}) => ({
  cible_type: 'batiment',
  cible_id: 'batiment-1',
  x: 40,
  y: 60,
  ...surcharge,
});

beforeEach(() => {
  jest.clearAllMocks();
  PlanHotspot.create.mockImplementation(async (valeurs) => ({ id: 'hotspot-1', ...valeurs }));
});

describe('HotspotService.creer — isolation multi-tenant', () => {
  it('refuse un plan qui n’appartient pas à l’organisation', async () => {
    // `_planDeLOrganisation` filtre sur le chantier de l'organisation : un
    // plan d'un autre client ne remonte simplement pas.
    Plan.findByPk.mockResolvedValue(null);

    const res = await HotspotService.creer(ORG, PLAN, donnees());

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
    expect(PlanHotspot.create).not.toHaveBeenCalled();
  });

  it('refuse un bâtiment appartenant à un AUTRE chantier', async () => {
    // C'est le cœur du contrôle : `cible_id` n'est qu'un UUID du corps de la
    // requête. Sans cette garde, un repère pouvait pointer vers la structure
    // d'un autre chantier — et la navigation la faisait apparaître.
    Plan.findByPk.mockResolvedValue(planValide());
    Batiment.findOne.mockResolvedValue(null);

    const res = await HotspotService.creer(ORG, PLAN, donnees());

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/n’appartient pas à ce chantier/);
    expect(PlanHotspot.create).not.toHaveBeenCalled();
    // La recherche doit bien être bornée au chantier du plan.
    expect(Batiment.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'batiment-1', chantierId: CHANTIER } })
    );
  });
});

describe('HotspotService.creer — cibles valides', () => {
  it('crée un repère vers un bâtiment du chantier', async () => {
    Plan.findByPk.mockResolvedValue(planValide());
    Batiment.findOne.mockResolvedValue({ id: 'batiment-1', nom: 'Bâtiment A' });

    const res = await HotspotService.creer(ORG, PLAN, donnees({ x: 12.5, y: 80 }));

    expect(res.success).toBe(true);
    expect(PlanHotspot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: PLAN,
        cible_type: 'batiment',
        cible_id: 'batiment-1',
        x: 12.5,
        y: 80,
      })
    );
  });

  it('reprend le nom de la cible quand aucun libellé n’est fourni', async () => {
    // La pastille affiche « BÂTIMENT A » sans que personne ait eu à le
    // retaper — c'est ce repli qui l'assure.
    Plan.findByPk.mockResolvedValue(planValide());
    Batiment.findOne.mockResolvedValue({ id: 'batiment-1', nom: 'Bâtiment A' });

    await HotspotService.creer(ORG, PLAN, donnees());

    expect(PlanHotspot.create).toHaveBeenCalledWith(
      expect.objectContaining({ libelle: 'Bâtiment A' })
    );
  });

  it('garde le libellé saisi quand il y en a un', async () => {
    Plan.findByPk.mockResolvedValue(planValide());
    Batiment.findOne.mockResolvedValue({ id: 'batiment-1', nom: 'Bâtiment A' });

    await HotspotService.creer(ORG, PLAN, donnees({ libelle: 'ENTRÉE CHANTIER' }));

    expect(PlanHotspot.create).toHaveBeenCalledWith(
      expect.objectContaining({ libelle: 'ENTRÉE CHANTIER' })
    );
  });

  it('accepte un étage en remontant par son bâtiment', async () => {
    Plan.findByPk.mockResolvedValue(planValide());
    Etage.findByPk.mockResolvedValue({ id: 'etage-1', nom: 'R+2' });

    const res = await HotspotService.creer(
      ORG, PLAN, donnees({ cible_type: 'etage', cible_id: 'etage-1' })
    );

    expect(res.success).toBe(true);
    // La contrainte de chantier est portée par la jointure sur le bâtiment,
    // pas par l'étage lui-même (qui ne connaît pas son chantier).
    const options = Etage.findByPk.mock.calls[0][1];
    expect(options.include[0]).toEqual(
      expect.objectContaining({ as: 'batiment', where: { chantierId: CHANTIER }, required: true })
    );
  });

  it('accepte une zone en remontant par son étage puis son bâtiment', async () => {
    Plan.findByPk.mockResolvedValue(planValide());
    Zone.findByPk.mockResolvedValue({ id: 'zone-1', nom: 'A203' });

    const res = await HotspotService.creer(
      ORG, PLAN, donnees({ cible_type: 'zone', cible_id: 'zone-1' })
    );

    expect(res.success).toBe(true);
    const options = Zone.findByPk.mock.calls[0][1];
    const etage = options.include[0];
    expect(etage).toEqual(expect.objectContaining({ as: 'etage', required: true }));
    expect(etage.include[0]).toEqual(
      expect.objectContaining({ as: 'batiment', where: { chantierId: CHANTIER }, required: true })
    );
  });

  it('applique les valeurs par défaut d’un repère ponctuel', async () => {
    // Largeur et hauteur nulles = simple point cliquable, sans cadre dessiné.
    // C'est le cas courant : poser un repère ne doit pas obliger à tracer une
    // surface.
    Plan.findByPk.mockResolvedValue(planValide());
    Batiment.findOne.mockResolvedValue({ id: 'batiment-1', nom: 'Bâtiment A' });

    await HotspotService.creer(ORG, PLAN, donnees());

    expect(PlanHotspot.create).toHaveBeenCalledWith(
      expect.objectContaining({ largeur: 0, hauteur: 0, page: 1 })
    );
  });
});

describe('HotspotService.modifier', () => {
  it('revérifie la cible quand elle change', async () => {
    // On ne fait pas confiance à la cohérence d'une cible déjà en base pour
    // valider la NOUVELLE : sans cette revérification, un repère légitime
    // pouvait être redirigé vers la structure d'un autre chantier.
    PlanHotspot.findByPk.mockResolvedValue({
      id: 'hotspot-1',
      cible_type: 'batiment',
      cible_id: 'batiment-1',
      plan: { id: PLAN, chantierId: CHANTIER },
      update: jest.fn(),
    });
    Batiment.findOne.mockResolvedValue(null); // cible hors chantier

    const res = await HotspotService.modifier(ORG, 'hotspot-1', { cible_id: 'batiment-etranger' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/n’appartient pas à ce chantier/);
  });

  it('n’exige aucune revérification pour un simple déplacement', async () => {
    // Déplacer un repère ne change pas sa cible : relancer la vérification
    // serait une requête inutile à chaque glissement.
    const update = jest.fn();
    PlanHotspot.findByPk.mockResolvedValue({
      id: 'hotspot-1',
      cible_type: 'batiment',
      cible_id: 'batiment-1',
      plan: { id: PLAN, chantierId: CHANTIER },
      update,
    });

    const res = await HotspotService.modifier(ORG, 'hotspot-1', { x: 55, y: 22 });

    expect(res.success).toBe(true);
    expect(Batiment.findOne).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ x: 55, y: 22 });
  });

  it('refuse un repère hors de l’organisation', async () => {
    PlanHotspot.findByPk.mockResolvedValue(null);

    const res = await HotspotService.modifier(ORG, 'hotspot-1', { x: 10 });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
  });
});
