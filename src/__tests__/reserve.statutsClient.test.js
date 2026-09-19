'use strict';

/**
 * Tests — statuts de réserve demandés par le client après la recette
 * (`a_surveiller`, `a_echeance`, `traitee`, `levee`) et choix de statut LIBRE.
 *
 * Ce que l'on vérifie, de bout en bout côté serveur :
 *   - le catalogue (`config/enums.js`) et ses familles (levées, fermées,
 *     traitées) sont cohérents ;
 *   - toute réserve en cours de vie peut recevoir n'importe quel statut,
 *     SAUF les règles d'intégrité (`creee` jamais destination, `cloturee`
 *     terminal et atteignable après verdict positif seulement) ;
 *   - `levee` obéit aux MÊMES règles que `validee` : rôle de pilotage, preuves
 *     exigées, `validePar` posé, ligne d'historique `validation` ;
 *   - `traitee` est déclarable par le sous-traitant comme `corrigee`.
 *
 * Même isolation que reserve.changerStatut.roles.test.js : modèles,
 * transaction et notifications mockés, la LOGIQUE seule est testée.
 */

jest.mock('../models/index.js', () => ({
  Reserve: { findByPk: jest.fn() },
  ReservePosition: {},
  ReserveHistorique: { create: jest.fn().mockResolvedValue({}) },
  Commentaire: {},
  Media: { count: jest.fn().mockResolvedValue(1) },
  Chantier: {},
  Batiment: {},
  Etage: {},
  Zone: {},
  Lot: {},
  Plan: {},
  Organisation: {},
  Utilisateur: {},
  PieceJointe: {},
  ReserveAffectation: { count: jest.fn().mockResolvedValue(0) },
  Signature: {},
  Partenaire: { findOne: jest.fn() },
}));
jest.mock('../config/db.js', () => ({
  transaction: jest.fn(),
}));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(undefined),
}));

const { Reserve, ReserveHistorique, Media } = require('../models/index.js');
const sequelize = require('../config/db.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');
const ENUMS = require('../config/enums.js');

const CLIENT = ['a_surveiller', 'a_echeance', 'traitee', 'levee'];

function fakeReserve(overrides = {}) {
  return {
    id: 'reserve-1',
    numero: 'R-0001',
    titre: 'Fissure',
    statut: 'creee',
    assigneA: null,
    creePar: 'createur-1',
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeTransaction() {
  return { commit: jest.fn().mockResolvedValue(undefined), rollback: jest.fn().mockResolvedValue(undefined) };
}

/** Lance un changement de statut par un rôle de pilotage depuis `depuis`. */
async function changer(depuis, vers, { role = 'ChefProjet', motif, reserve = {} } = {}) {
  const r = fakeReserve({ statut: depuis, ...reserve });
  Reserve.findByPk.mockResolvedValue(r);
  const result = await ReserveService.changerStatut('org-1', r.id, vers, { motif }, 'user-1', role);
  return { result, reserve: r };
}

beforeEach(() => {
  jest.clearAllMocks();
  Media.count.mockResolvedValue(1);
  ReserveHistorique.create.mockResolvedValue({});
  sequelize.transaction.mockResolvedValue(fakeTransaction());
});

describe('catalogue des statuts (config/enums.js)', () => {
  it('contient les quatre statuts du client', () => {
    for (const s of CLIENT) expect(ENUMS.STATUT_RESERVE).toContain(s);
  });

  it('range chaque statut du client à sa place dans le cycle de vie', () => {
    const rang = (s) => ENUMS.STATUT_RESERVE.indexOf(s);
    expect(rang('a_surveiller')).toBeGreaterThan(rang('en_cours'));
    expect(rang('a_echeance')).toBeGreaterThan(rang('a_surveiller'));
    expect(rang('traitee')).toBeGreaterThan(rang('corrigee'));
    expect(rang('levee')).toBeGreaterThan(rang('validee'));
    expect(rang('cloturee')).toBe(ENUMS.STATUT_RESERVE.length - 1);
  });

  it('« levée » est un verdict positif, donc fermée ; « traitée » attend le contrôle', () => {
    expect(ENUMS.STATUTS_RESERVE_LEVEES).toEqual(['validee', 'levee']);
    expect(ENUMS.STATUTS_RESERVE_FERMES).toEqual(['validee', 'levee', 'cloturee']);
    expect(ENUMS.STATUTS_RESERVE_TRAITEES).toContain('traitee');
    expect(ENUMS.STATUTS_RESERVE_TRAITEES).toContain('corrigee');
    // Traitée n'est PAS fermée : elle reste dans les ouvertes tant que le
    // contrôle n'a pas tranché.
    expect(ENUMS.STATUTS_RESERVE_FERMES).not.toContain('traitee');
  });

  it('chaque statut a un libellé français pour les textes serveur', () => {
    for (const s of ENUMS.STATUT_RESERVE) {
      expect(typeof ENUMS.LIBELLE_STATUT_RESERVE[s]).toBe('string');
    }
  });

  it('le catalogue public servi aux clients expose les statuts du client', () => {
    for (const s of CLIENT) expect(ENUMS.VUE_PUBLIQUE.statutsReserve).toContain(s);
  });
});

describe('changerStatut — choix de statut libre', () => {
  const VIVANTS = ENUMS.STATUT_RESERVE.filter((s) => !ENUMS.STATUTS_RESERVE_FERMES.includes(s));
  const DESTINATIONS_LIBRES = ENUMS.STATUT_RESERVE.filter((s) => s !== 'creee' && s !== 'cloturee');

  it.each(VIVANTS.flatMap((d) => DESTINATIONS_LIBRES.filter((v) => v !== d).map((v) => [d, v])))(
    '%s → %s est accepté par un rôle de pilotage',
    async (depuis, vers) => {
      const { result } = await changer(depuis, vers, { motif: 'motif de refus' });
      expect(result).toMatchObject({ success: true });
    },
  );

  it.each(ENUMS.STATUT_RESERVE.filter((s) => s !== 'creee'))('%s → creee est refusé (état initial)', async (depuis) => {
    const { result } = await changer(depuis, 'creee');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/transition impossible/i);
  });

  it.each(VIVANTS)('%s → cloturee est refusé : la clôture suit un verdict positif', async (depuis) => {
    const { result } = await changer(depuis, 'cloturee');
    expect(result.success).toBe(false);
  });

  it.each(ENUMS.STATUTS_RESERVE_LEVEES)('%s → cloturee est accepté', async (depuis) => {
    const { result } = await changer(depuis, 'cloturee');
    expect(result.success).toBe(true);
  });

  it('cloturee est TERMINAL : aucune sortie', async () => {
    for (const vers of ENUMS.STATUT_RESERVE.filter((s) => s !== 'cloturee')) {
      const { result } = await changer('cloturee', vers, { motif: 'x' });
      expect({ vers, success: result.success }).toEqual({ vers, success: false });
    }
  });

  it('un verdict positif ne se défait que par une réouverture explicite', async () => {
    const { result: enCours } = await changer('levee', 'en_cours');
    expect(enCours.success).toBe(false);
    const { result: rouverte } = await changer('levee', 'rouverte');
    expect(rouverte.success).toBe(true);
  });
});

describe('changerStatut — « levée » obéit aux règles de « validée »', () => {
  it('exige des preuves de correction', async () => {
    Media.count.mockResolvedValue(0);
    const { result } = await changer('traitee', 'levee');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/preuves/i);
  });

  it('pose validePar + date_validation, historise une « validation » et notifie « Réserve levée »', async () => {
    const { result, reserve } = await changer('traitee', 'levee');
    expect(result.success).toBe(true);

    const [updates] = reserve.update.mock.calls[0];
    expect(updates).toMatchObject({ statut: 'levee', validePar: 'user-1', motif_refus: null });
    expect(updates.date_validation).toBeInstanceOf(Date);

    expect(ReserveHistorique.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'validation',
        anciennes_valeurs: { statut: 'traitee' },
        nouvelles_valeurs: { statut: 'levee' },
      }),
      expect.anything(),
    );

    expect(NotificationService.notifier).toHaveBeenCalledWith(
      expect.objectContaining({ titre: 'Réserve levée', donnees: { reserveId: 'reserve-1', statut: 'levee' } }),
    );
  });

  it('est réservée aux rôles de pilotage', async () => {
    const { result } = await changer('traitee', 'levee', { role: 'Pilote' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/rôle/i);
  });

  it('un statut sans verdict efface le verdict précédent', async () => {
    const { reserve } = await changer('refusee', 'a_surveiller');
    const [updates] = reserve.update.mock.calls[0];
    expect(updates).toMatchObject({ statut: 'a_surveiller', validePar: null, date_validation: null, motif_refus: null });
  });

  it('refusée exige toujours un motif', async () => {
    const { result } = await changer('a_echeance', 'refusee');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/motif/i);
  });
});

describe('changerStatut — sous-traitant et statuts du client', () => {
  it('peut déclarer « traitée » sur SA réserve', async () => {
    const r = fakeReserve({ statut: 'en_cours', assigneA: 'st-1' });
    Reserve.findByPk.mockResolvedValue(r);
    const result = await ReserveService.changerStatut('org-1', r.id, 'traitee', {}, 'st-1', 'SousTraitant');
    expect(result.success).toBe(true);
  });

  it.each(['a_surveiller', 'a_echeance', 'levee'])('ne peut pas poser « %s »', async (vers) => {
    const r = fakeReserve({ statut: 'en_cours', assigneA: 'st-1' });
    Reserve.findByPk.mockResolvedValue(r);
    const result = await ReserveService.changerStatut('org-1', r.id, vers, {}, 'st-1', 'SousTraitant');
    expect(result.success).toBe(false);
  });
});

describe('changerStatut — rejeu idempotent avec un statut du client', () => {
  it('« à surveiller → à surveiller » est un rejeu, pas une erreur', async () => {
    const { result, reserve } = await changer('a_surveiller', 'a_surveiller');
    expect(result).toMatchObject({ success: true, rejeu: true });
    expect(reserve.update).not.toHaveBeenCalled();
  });
});
