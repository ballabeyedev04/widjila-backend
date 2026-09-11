'use strict';

/**
 * Tests — suggestions du champ « Observation » (GET /reserves/observations).
 *
 * Exigences couvertes :
 *   - historique « coins casse », saisie « coi » → suggestion « coins casse » ;
 *   - recherche insensible à la casse ET aux accents ;
 *   - pertinente : une saisie ne propose pas toutes les observations ;
 *   - sans doublon (casse, accents, espaces près) ;
 *   - périmètre : les réserves de l'utilisateur, dans son organisation ;
 *   - aucune suggestion : liste vide, sans erreur.
 */

jest.mock('../models/index.js', () => ({
  Reserve: { findAll: jest.fn() },
  Chantier: {},
}));

const { Reserve } = require('../models/index.js');
const ObservationsService = require('../modules/reserve/service/observations.service.js');

const UTILISATEUR = { id: 'u-1', organisationId: 'org-1' };

/** Lignes renvoyées par la base, la plus récente d'abord. */
const historique = (...descriptions) => {
  Reserve.findAll.mockResolvedValue(descriptions.map((description) => ({ description })));
};

const suggerer = (q, limit) => ObservationsService
  .listerObservationsUtilisees(UTILISATEUR, { q, limit })
  .then((r) => r.observations);

beforeEach(() => Reserve.findAll.mockReset());

describe('périmètre', () => {
  it('ne lit que les réserves de l’utilisateur, dans son organisation, les plus récentes d’abord', async () => {
    historique();

    await suggerer('');

    const options = Reserve.findAll.mock.calls[0][0];
    expect(options.where.creePar).toBe('u-1');
    expect(options.include[0]).toMatchObject({ as: 'chantier', where: { organisationId: 'org-1' }, required: true });
    expect(options.order).toEqual([['createdAt', 'DESC']]);
  });

  it('sans organisation (super-admin) : aucune suggestion, aucune lecture', async () => {
    const r = await ObservationsService.listerObservationsUtilisees({ id: 'admin', organisationId: null }, {});

    expect(r.observations).toEqual([]);
    expect(Reserve.findAll).not.toHaveBeenCalled();
  });
});

describe('filtrage', () => {
  beforeEach(() => historique('coins casse', 'fissure plafond', 'joint de carrelage à reprendre'));

  it('« coi » propose « coins casse », et seulement elle', async () => {
    expect(await suggerer('coi')).toEqual(['coins casse']);
  });

  it('insensible à la casse et aux accents', async () => {
    historique('Coins cassés', 'fissure plafond');

    expect(await suggerer('COINS CASSES')).toEqual(['Coins cassés']);
    expect(await suggerer('coins cassés')).toEqual(['Coins cassés']);
  });

  it('un mot tapé peut être le début d’un mot qui n’est pas le premier', async () => {
    expect(await suggerer('cas')).toEqual(['coins casse']);
    expect(await suggerer('plaf fis')).toEqual(['fissure plafond']);
    expect(await suggerer('carrel')).toEqual(['joint de carrelage à reprendre']);
  });

  it('pas d’inclusion au milieu d’un mot : « ssure » ne propose rien', async () => {
    expect(await suggerer('ssure')).toEqual([]);
  });

  it('aucune correspondance : liste vide, sans erreur', async () => {
    expect(await suggerer('peinture écaillée')).toEqual([]);
  });

  it('sans saisie : l’historique complet, pour la mise en cache du mobile', async () => {
    expect(await suggerer('')).toHaveLength(3);
  });
});

describe('doublons et classement', () => {
  it('une même observation n’apparaît qu’une fois, sous sa formulation la plus récente', async () => {
    historique('Coins cassés', 'coins casses', '  coins   CASSÉS ', 'fissure');

    expect(await suggerer('coi')).toEqual(['Coins cassés']);
  });

  it('les observations qui COMMENCENT par la saisie passent devant', async () => {
    historique('mur fissuré', 'fissure plafond');

    expect(await suggerer('fis')).toEqual(['fissure plafond', 'mur fissuré']);
  });

  it('à pertinence égale, la plus employée passe devant', async () => {
    historique('joint à reprendre', 'joint fissuré', 'joint fissuré', 'joint fissuré');

    expect(await suggerer('joint')).toEqual(['joint fissuré', 'joint à reprendre']);
  });

  it('les textes vides et les comptes rendus trop longs ne sont pas des suggestions', async () => {
    historique('', null, `coins ${'x'.repeat(400)}`, 'coins casse');

    expect(await suggerer('coi')).toEqual(['coins casse']);
  });

  it('respecte la limite demandée', async () => {
    historique('joint 1', 'joint 2', 'joint 3', 'joint 4');

    expect(await suggerer('joint', 2)).toHaveLength(2);
  });
});
