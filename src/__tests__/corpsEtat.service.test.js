'use strict';

/**
 * Tests — modules/corpsEtat/service/corpsEtat.service.js
 *
 * Le catalogue des métiers BTP est une donnée PARTAGÉE : une partie appartient
 * à la plateforme (`organisationId = null`, visible de tous), le reste à
 * chaque organisation. Ce qui doit être verrouillé :
 *
 *   1. VISIBILITÉ — on voit le standard + le sien, jamais celui d'un autre ;
 *   2. ÉCRITURE   — on ne modifie que ce qu'on possède ; le catalogue
 *                   standard n'appartient qu'au super-admin ;
 *   3. SUPPRESSION — refusée tant que des réserves l'utilisent, avec un
 *                   décompte exact et une invitation à désactiver ;
 *   4. RECHERCHE  — ne doit jamais faire fuiter le catalogue d'un voisin.
 *
 * Modèles Sequelize mockés — même approche que les autres tests du projet.
 */

jest.mock('../models/index.js', () => ({
  CorpsEtat: {
    findAndCountAll: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
  },
  Reserve: { count: jest.fn() },
}));

const { Op, UniqueConstraintError } = require('sequelize');
const { CorpsEtat, Reserve } = require('../models/index.js');
const CorpsEtatService = require('../modules/corpsEtat/service/corpsEtat.service.js');

const ORG = 'org-1';
const AUTRE_ORG = 'org-2';
const ID = 'ce-1';

const ligne = (extra = {}) => ({
  id: ID,
  organisationId: ORG,
  nom: 'Serrurerie',
  destroy: jest.fn().mockResolvedValue(),
  update: jest.fn().mockResolvedValue(),
  ...extra,
});

/** Aplatit un `where` Sequelize (symboles compris) en JSON lisible. */
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
  CorpsEtat.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
  CorpsEtat.findAll.mockResolvedValue([]);
  Reserve.count.mockResolvedValue(0);
});

describe('visibilité', () => {
  it('montre le catalogue standard ET celui de l’organisation', async () => {
    await CorpsEtatService.lister(ORG, {});

    const where = decrire(CorpsEtat.findAndCountAll.mock.calls[0][0].where);
    const ou = where[Op.or.toString()];
    expect(ou).toEqual([{ organisationId: null }, { organisationId: ORG }]);
  });

  it('ne montre QUE le standard à un utilisateur sans organisation', async () => {
    await CorpsEtatService.lister(null, {});

    const where = decrire(CorpsEtat.findAndCountAll.mock.calls[0][0].where);
    expect(where).toEqual({ organisationId: null });
  });

  it('lève le filtre pour le super-admin plateforme', async () => {
    await CorpsEtatService.lister(null, {}, { toutesOrganisations: true });

    const where = decrire(CorpsEtat.findAndCountAll.mock.calls[0][0].where);
    expect(where).toEqual({});
  });

  it('la recherche N’ÉCRASE PAS le filtre de visibilité', async () => {
    // Le piège : réécrire `where[Op.or]` pour la recherche effacerait le
    // filtre d'organisation, et « peinture » ferait remonter les métiers de
    // tous les clients de la plateforme.
    await CorpsEtatService.lister(ORG, { search: 'peint' });

    const where = decrire(CorpsEtat.findAndCountAll.mock.calls[0][0].where);
    expect(where[Op.or.toString()]).toEqual([{ organisationId: null }, { organisationId: ORG }]);
    expect(where[Op.and.toString()]).toHaveLength(1);
  });

  it('ne remonte que les métiers actifs pour les listes déroulantes', async () => {
    await CorpsEtatService.listerActifs(ORG);

    const where = decrire(CorpsEtat.findAll.mock.calls[0][0].where);
    expect(where.actif).toBe(true);
  });

  it('trie par ordre de chantier avant l’alphabétique', async () => {
    // L'ordre du BTP (démolition → gros œuvre → finitions) ne coïncide pas
    // avec l'ordre alphabétique : trier sur le nom rendrait la liste
    // inutilisable sur un planning.
    await CorpsEtatService.listerActifs(ORG);

    expect(CorpsEtat.findAll.mock.calls[0][0].order).toEqual([['ordre', 'ASC'], ['nom', 'ASC']]);
  });
});

describe('écriture — propriété de la ligne', () => {
  it('refuse de modifier une ligne du catalogue standard', async () => {
    CorpsEtat.findByPk.mockResolvedValue(ligne({ organisationId: null }));

    const res = await CorpsEtatService.modifier(ORG, ID, { nom: 'X' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/catalogue standard/i);
  });

  it('laisse le super-admin modifier le catalogue standard', async () => {
    const cible = ligne({ organisationId: null });
    CorpsEtat.findByPk.mockResolvedValue(cible);

    const res = await CorpsEtatService.modifier(null, ID, { nom: 'Serrurerie / Métallerie' }, { superAdmin: true });

    expect(res.success).toBe(true);
    expect(cible.update).toHaveBeenCalledWith({ nom: 'Serrurerie / Métallerie' });
  });

  it('traite la ligne d’une autre organisation comme introuvable', async () => {
    // « Introuvable » et non « interdit » : répondre 403 confirmerait
    // l'existence de la ligne, et permettrait d'énumérer le catalogue d'un
    // concurrent identifiant par identifiant.
    CorpsEtat.findByPk.mockResolvedValue(ligne({ organisationId: AUTRE_ORG }));

    const res = await CorpsEtatService.modifier(ORG, ID, { nom: 'X' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/introuvable/i);
    expect(res.message).not.toMatch(/standard/i);
  });

  it('crée toujours dans SA propre organisation, même si le client en désigne une autre', async () => {
    CorpsEtat.create.mockResolvedValue(ligne());

    await CorpsEtatService.creer(ORG, { nom: 'Désamiantage', organisationId: AUTRE_ORG });

    expect(CorpsEtat.create.mock.calls[0][0].organisationId).toBe(ORG);
  });

  it('laisse le super-admin viser le catalogue standard', async () => {
    CorpsEtat.create.mockResolvedValue(ligne({ organisationId: null }));

    await CorpsEtatService.creer(null, { nom: 'Désamiantage' }, { superAdmin: true });

    expect(CorpsEtat.create.mock.calls[0][0].organisationId).toBeNull();
  });

  it('vide `code` et `description` en NULL plutôt qu’en chaîne vide', async () => {
    // Une chaîne vide s'afficherait comme un code existant et casserait le
    // rapprochement par code avec l'ancien ENUM.
    const cible = ligne();
    CorpsEtat.findByPk.mockResolvedValue(cible);

    await CorpsEtatService.modifier(ORG, ID, { code: '', description: '' });

    expect(cible.update).toHaveBeenCalledWith({ code: null, description: null });
  });

  it('traduit une collision d’unicité en message métier', async () => {
    const collision = new UniqueConstraintError({ errors: [] });
    CorpsEtat.create.mockRejectedValue(collision);

    const res = await CorpsEtatService.creer(ORG, { nom: 'Peinture' });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/porte déjà ce nom/i);
  });

  it('laisse remonter une panne réelle au lieu de la maquiller', async () => {
    CorpsEtat.create.mockRejectedValue(new Error('connexion perdue'));

    await expect(CorpsEtatService.creer(ORG, { nom: 'Plâtrerie' })).rejects.toThrow('connexion perdue');
  });
});

describe('activation / désactivation', () => {
  it('désactive sans supprimer', async () => {
    const cible = ligne();
    CorpsEtat.findByPk.mockResolvedValue(cible);

    const res = await CorpsEtatService.basculerActif(ORG, ID, false);

    expect(res.success).toBe(true);
    expect(cible.update).toHaveBeenCalledWith({ actif: false });
    expect(cible.destroy).not.toHaveBeenCalled();
  });

  it('refuse de basculer une ligne du catalogue standard', async () => {
    CorpsEtat.findByPk.mockResolvedValue(ligne({ organisationId: null }));

    const res = await CorpsEtatService.basculerActif(ORG, ID, false);

    expect(res.success).toBe(false);
  });
});

describe('suppression', () => {
  it('refuse tant que des réserves l’utilisent, et propose la désactivation', async () => {
    CorpsEtat.findByPk.mockResolvedValue(ligne());
    Reserve.count.mockResolvedValue(12);

    const res = await CorpsEtatService.supprimer(ORG, ID);

    expect(res.success).toBe(false);
    expect(res.message).toContain('12 réserves');
    expect(res.message).toMatch(/désactivez/i);
  });

  it('accorde le singulier sur une seule réserve', async () => {
    CorpsEtat.findByPk.mockResolvedValue(ligne());
    Reserve.count.mockResolvedValue(1);

    const res = await CorpsEtatService.supprimer(ORG, ID);

    expect(res.message).toMatch(/^1 réserve utilise/);
  });

  it('supprime quand plus rien ne l’utilise', async () => {
    const cible = ligne();
    CorpsEtat.findByPk.mockResolvedValue(cible);

    const res = await CorpsEtatService.supprimer(ORG, ID);

    expect(res.success).toBe(true);
    expect(cible.destroy).toHaveBeenCalled();
  });

  it('ne compte pas les réserves avant d’avoir vérifié la propriété', async () => {
    // Sinon un `count` sur l'identifiant d'une autre organisation révélerait,
    // par son message, le nombre de réserves qu'elle porte.
    CorpsEtat.findByPk.mockResolvedValue(ligne({ organisationId: AUTRE_ORG }));

    await CorpsEtatService.supprimer(ORG, ID);

    expect(Reserve.count).not.toHaveBeenCalled();
  });
});
