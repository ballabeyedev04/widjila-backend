'use strict';

/**
 * Tests — la liste transversale des réserves (`GET /api/v1/reserves`) respecte
 * le cloisonnement par chantier.
 *
 * Un chantier issu du circuit de demande n'est ouvert, hors rôles de gestion,
 * qu'à celui qui l'a demandé et à ses membres affectés
 * (`ChantierService.filtreCloisonnement`). Le détail d'un chantier appliquait
 * la règle ; cette liste, non : un sous-traitant ou un client y lisait les
 * réserves — et le nom — de chantiers qu'il ne pouvait pas ouvrir.
 */

const modele = () => ({
  findOne: jest.fn(), findAll: jest.fn(), findByPk: jest.fn(), count: jest.fn(),
  create: jest.fn(), update: jest.fn(), destroy: jest.fn(),
  findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
});

jest.mock('../models/index.js', () => new Proxy({}, {
  get(cible, nom) {
    if (typeof nom !== 'string' || nom === '__esModule' || nom === 'then') return undefined;
    if (!(nom in cible)) cible[nom] = modele();
    return cible[nom];
  },
}));

const { Op } = require('sequelize');
const { Reserve } = require('../models/index.js');
const ReserveService = require('../modules/reserve/service/reserve.service.js');

/** Le `where` posé sur le chantier joint, tel que la requête l'envoie. */
async function whereChantierPour(auteur, portee = {}) {
  Reserve.findAndCountAll.mockClear();
  await ReserveService.listToutesReserves('org-1', {}, portee, auteur);
  const [options] = Reserve.findAndCountAll.mock.calls[0];
  return options.include.find((i) => i.as === 'chantier').where;
}

describe('liste de toutes les réserves', () => {
  it.each(['SousTraitant', 'Client', 'ConducteurTravaux', 'Pilote'])(
    '%s : restreinte aux chantiers qu’il peut ouvrir',
    async (role) => {
      const where = await whereChantierPour({ id: 'u-1', role });

      expect(where.organisationId).toBe('org-1');
      const branches = where[Op.or];
      expect(Array.isArray(branches)).toBe(true);
      expect(branches).toEqual(expect.arrayContaining([{ demandeurId: null }, { demandeurId: 'u-1' }]));
    }
  );

  it.each(['ChefProjet', 'MaitreOuvrage', 'Entreprise'])(
    '%s (gestion) : toute l’organisation, comme avant',
    async (role) => {
      const where = await whereChantierPour({ id: 'u-1', role });

      expect(where).toEqual({ organisationId: 'org-1' });
    }
  );

  it('super-admin sans organisation ciblée : aucune restriction', async () => {
    Reserve.findAndCountAll.mockClear();
    await ReserveService.listToutesReserves(null, {}, { toutesOrganisations: true }, { id: 'a', role: 'Admin' });
    const [options] = Reserve.findAndCountAll.mock.calls[0];

    expect(options.include.find((i) => i.as === 'chantier').where).toEqual({});
  });

  it('le cloisonnement ne dépend jamais d’un paramètre client', async () => {
    // Même avec un `chantierId` choisi par le client, le filtre du chantier
    // joint reste celui de l'appelant.
    Reserve.findAndCountAll.mockClear();
    await ReserveService.listToutesReserves('org-1', { chantierId: 'c-autre' }, {}, { id: 'u-1', role: 'Client' });
    const [options] = Reserve.findAndCountAll.mock.calls[0];

    expect(options.where.chantierId).toBe('c-autre');
    expect(options.include.find((i) => i.as === 'chantier').where[Op.or]).toBeDefined();
  });
});
