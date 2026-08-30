'use strict';

/**
 * Tests — modules/chantier/service/chantier.service.js, partie STRUCTURE
 * (modification et suppression de bâtiment / étage / zone).
 *
 * Seule la création existait jusqu'ici. Ce qui doit être verrouillé n'est pas
 * l'écriture elle-même — triviale — mais la RÈGLE DE SUPPRESSION :
 *
 *   1. on refuse tant qu'une réserve pointe sur l'élément ou l'un de ses
 *      descendants (une réserve est une pièce contradictoire : effacer sa
 *      localisation réécrirait après coup ce qui a été constaté) ;
 *   2. les plans sont DÉTACHÉS, pas supprimés — le document survit à sa zone ;
 *   3. la descente bâtiment → étages → zones est explicite, les modèles étant
 *      `paranoid` (les CASCADE ne se déclenchent pas sur un soft delete) ;
 *   4. l'isolation multi-tenant tient sur les jointures de cadrage.
 *
 * Modèles Sequelize mockés — même approche que hotspot.service.test.js.
 */

jest.mock('../models/index.js', () => ({
  Chantier: { findOne: jest.fn() },
  Batiment: { findOne: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
  Etage: { findOne: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
  Zone: { findOne: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
  Lot: { destroy: jest.fn() },
  Reserve: { count: jest.fn(), destroy: jest.fn() },
  Utilisateur: {},
  ChantierMembre: {},
  Phase: { destroy: jest.fn() },
  Inspection: { findAll: jest.fn() },
  Plan: { update: jest.fn(), destroy: jest.fn() },
  Annotation: {},
  Document: { destroy: jest.fn() },
  Rapport: { destroy: jest.fn() },
  Checklist: { destroy: jest.fn() },
  Commentaire: {},
  PieceJointe: {},
  Organisation: {},
  PlanHotspot: { destroy: jest.fn() },
}));
jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

const { Batiment, Etage, Zone, Reserve, Plan, PlanHotspot } = require('../models/index.js');
const sequelize = require('../config/db.js');
const ChantierService = require('../modules/chantier/service/chantier.service.js');

const ORG = 'org-1';
const CHANTIER = 'chantier-1';
const BATIMENT = 'batiment-1';
const ETAGE = 'etage-1';
const ZONE = 'zone-1';

/** Transaction factice — on vérifie seulement qu'elle est menée à son terme. */
function transactionFactice() {
  const t = { commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() };
  sequelize.transaction.mockResolvedValue(t);
  return t;
}

/**
 * Extrait les clauses d'un `{ [Op.or]: [...] }`.
 *
 * `Op.or` est une clé SYMBOLE : `JSON.stringify` la laisse tomber
 * silencieusement, et une assertion écrite dessus passerait sur un objet vide.
 */
const clausesOu = (where) => {
  const symbole = Object.getOwnPropertySymbols(where).find((sy) => Array.isArray(where[sy]));
  return symbole ? where[symbole] : [];
};

/** Tous les identifiants cités par un jeu de clauses, à plat. */
const idsCites = (clauses) =>
  clauses.flatMap((clause) =>
    Object.values(clause).flatMap((valeur) =>
      Object.getOwnPropertySymbols(valeur).flatMap((sy) => valeur[sy])
    )
  );

const ligne = (id, extra = {}) => ({
  id,
  destroy: jest.fn().mockResolvedValue(),
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  Etage.findAll.mockResolvedValue([]);
  Zone.findAll.mockResolvedValue([]);
  Reserve.count.mockResolvedValue(0);
  Plan.update.mockResolvedValue([0]);
  PlanHotspot.destroy.mockResolvedValue(0);
  Zone.destroy.mockResolvedValue(0);
  Etage.destroy.mockResolvedValue(0);
});

describe('suppression — garde des réserves', () => {
  it('refuse de supprimer un bâtiment portant des réserves, et dit combien', async () => {
    Batiment.findOne.mockResolvedValue(ligne(BATIMENT));
    Reserve.count.mockResolvedValue(7);

    const res = await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    expect(res.success).toBe(false);
    expect(res.message).toContain('7 réserves');
    // Rien ne doit avoir été touché : ni transaction, ni détachement de plan.
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(Plan.update).not.toHaveBeenCalled();
  });

  it('accorde le singulier quand une seule réserve bloque', async () => {
    // Un message au pluriel sur une unique réserve donne l'impression d'un
    // décompte faux, et fait douter du reste.
    Zone.findOne.mockResolvedValue(ligne(ZONE));
    Reserve.count.mockResolvedValue(1);

    const res = await ChantierService.supprimerZone(ORG, CHANTIER, BATIMENT, ETAGE, ZONE);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/^1 réserve est rattachée/);
  });

  it('compte les réserves des DESCENDANTS, pas seulement du bâtiment', async () => {
    // Une réserve posée sur un appartement peut ne porter que `zoneId`.
    // Ne regarder que `batimentId` laisserait supprimer le bâtiment qui la
    // contient — et la réserve perdrait sa localisation.
    transactionFactice();
    Batiment.findOne.mockResolvedValue(ligne(BATIMENT));
    Etage.findAll.mockResolvedValue([{ id: ETAGE }]);
    Zone.findAll.mockResolvedValue([{ id: ZONE }]);

    await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    const cites = idsCites(clausesOu(Reserve.count.mock.calls[0][0].where));
    expect(cites).toEqual(expect.arrayContaining([BATIMENT, ETAGE, ZONE]));
  });
});

describe('suppression — effets sur les éléments liés', () => {
  it('détache les plans au lieu de les supprimer', async () => {
    // Le document survit à sa zone : il remonte d'un niveau et reste
    // consultable, ce qui est le comportement attendu d'un plan d'étage dont
    // l'étage disparaît.
    const t = transactionFactice();
    Batiment.findOne.mockResolvedValue(ligne(BATIMENT));
    Etage.findAll.mockResolvedValue([{ id: ETAGE }]);
    Zone.findAll.mockResolvedValue([{ id: ZONE }]);

    const res = await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    expect(res.success).toBe(true);
    expect(Plan.destroy).not.toHaveBeenCalled();
    const champsRemisANull = Plan.update.mock.calls.map((c) => Object.keys(c[0])[0]);
    expect(champsRemisANull).toEqual(expect.arrayContaining(['zoneId', 'etageId', 'batimentId']));
    expect(t.commit).toHaveBeenCalled();
  });

  it('efface les repères qui visaient la structure supprimée', async () => {
    // Un hotspot orphelin laisse sur le plan une pastille qui ne mène nulle
    // part — pire qu'une absence de repère.
    transactionFactice();
    Batiment.findOne.mockResolvedValue(ligne(BATIMENT));
    Etage.findAll.mockResolvedValue([{ id: ETAGE }]);

    await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    expect(PlanHotspot.destroy).toHaveBeenCalledTimes(1);
    const clauses = clausesOu(PlanHotspot.destroy.mock.calls[0][0].where);
    expect(clauses.map((c) => c.cible_type)).toEqual(expect.arrayContaining(['batiment', 'etage']));
    expect(idsCites(clauses)).toEqual(expect.arrayContaining([BATIMENT, ETAGE]));
  });

  it('descend explicitement bâtiment → étages → zones', async () => {
    // Les modèles sont `paranoid` : `destroy()` fait un soft delete et les
    // CASCADE de clés étrangères ne se déclenchent pas. Sans cette descente,
    // les étages et zones resteraient visibles après suppression du bâtiment.
    transactionFactice();
    const batiment = ligne(BATIMENT);
    Batiment.findOne.mockResolvedValue(batiment);
    Etage.findAll.mockResolvedValue([{ id: ETAGE }]);
    Zone.findAll.mockResolvedValue([{ id: ZONE }]);

    await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    expect(Zone.destroy).toHaveBeenCalled();
    expect(Etage.destroy).toHaveBeenCalled();
    expect(batiment.destroy).toHaveBeenCalled();
  });

  it('annule tout si une écriture échoue en cours de route', async () => {
    const t = transactionFactice();
    const batiment = ligne(BATIMENT);
    batiment.destroy.mockRejectedValue(new Error('panne base'));
    Batiment.findOne.mockResolvedValue(batiment);

    await expect(ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT)).rejects.toThrow('panne base');
    expect(t.rollback).toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
  });
});

describe('suppression — isolation multi-tenant', () => {
  it('refuse un bâtiment absent de ce chantier ou de cette organisation', async () => {
    // Le cadrage est porté par la jointure de `_batimentCadre` : un bâtiment
    // d'un autre client ne remonte simplement pas.
    Batiment.findOne.mockResolvedValue(null);

    const res = await ChantierService.supprimerBatiment(ORG, CHANTIER, BATIMENT);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it('refuse un étage absent du bâtiment visé', async () => {
    Etage.findOne.mockResolvedValue(null);

    const res = await ChantierService.supprimerEtage(ORG, CHANTIER, BATIMENT, ETAGE);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
  });
});

describe('modification', () => {
  it('renomme un bâtiment et vide le code quand il est effacé', async () => {
    // `code: ''` doit devenir `null` et non la chaîne vide : la colonne est
    // nullable, et une chaîne vide s'afficherait comme un code existant.
    const batiment = ligne(BATIMENT);
    Batiment.findOne.mockResolvedValue(batiment);

    const res = await ChantierService.modifierBatiment(ORG, CHANTIER, BATIMENT, { nom: 'Bâtiment B', code: '' });

    expect(res.success).toBe(true);
    expect(batiment.update).toHaveBeenCalledWith({ nom: 'Bâtiment B', code: null });
  });

  it('ne touche qu’aux champs réellement fournis', async () => {
    // Un PUT partiel ne doit pas remettre `niveau` à sa valeur par défaut :
    // un étage renommé se retrouverait rangé parmi les rez-de-chaussée.
    const etage = ligne(ETAGE);
    Etage.findOne.mockResolvedValue(etage);

    await ChantierService.modifierEtage(ORG, CHANTIER, BATIMENT, ETAGE, { nom: 'R+3' });

    expect(etage.update).toHaveBeenCalledWith({ nom: 'R+3' });
  });

  it('accepte le niveau 0 sans le confondre avec une absence de valeur', async () => {
    // Le piège classique : `if (data.niveau)` écarterait le rez-de-chaussée.
    const etage = ligne(ETAGE);
    Etage.findOne.mockResolvedValue(etage);

    await ChantierService.modifierEtage(ORG, CHANTIER, BATIMENT, ETAGE, { niveau: 0 });

    expect(etage.update).toHaveBeenCalledWith({ niveau: 0 });
  });

  it('modifie le type d’une zone', async () => {
    const zone = ligne(ZONE);
    Zone.findOne.mockResolvedValue(zone);

    const res = await ChantierService.modifierZone(ORG, CHANTIER, BATIMENT, ETAGE, ZONE, { type: 'logement' });

    expect(res.success).toBe(true);
    expect(zone.update).toHaveBeenCalledWith({ type: 'logement' });
  });
});
