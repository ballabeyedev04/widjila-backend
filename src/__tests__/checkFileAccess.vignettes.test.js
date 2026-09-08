'use strict';

/**
 * Tests — l'autorisation d'accès aux fichiers de `/uploads`.
 *
 * ## Le bug corrigé
 *
 * `media.service.js` stocke DEUX fichiers pour une photo : l'original
 * (`Media.url`) et sa vignette (`Media.thumbnail_url`), chacun avec sa propre
 * URL. Or toutes les LISTES servent la vignette — la liste des réserves, les
 * repères d'un plan, le tableau de bord — parce qu'elle pèse quelques dizaines
 * de kilo-octets là où l'original en fait plusieurs mégaoctets.
 *
 * Ce middleware, lui, ne cherchait le propriétaire que sur `url`. Une requête
 * de vignette ne correspondait donc à aucune ligne, il concluait « fichier
 * orphelin » et répondait 404. Résultat : AUCUNE photo de réserve n'apparaissait
 * dans les listes, et le refus était mis en cache une minute — il survivait
 * donc à un rafraîchissement, ce qui le faisait passer pour aléatoire.
 *
 * ## Ce que ces tests verrouillent
 *
 * Que la vignette soit résolue comme l'original, et que le cloisonnement entre
 * organisations ne soit pas relâché au passage : élargir une clause `WHERE`
 * est exactement le genre de correction qui ouvre une fuite si on la fait mal.
 */

const { Op } = require('sequelize');

jest.mock('../models/index.js', () => ({
  Plan: { findOne: jest.fn() },
  Document: { findOne: jest.fn() },
  Rapport: { findOne: jest.fn() },
  Media: { findOne: jest.fn() },
  PieceJointe: { findOne: jest.fn() },
  Reserve: { findByPk: jest.fn() },
  Inspection: { findByPk: jest.fn() },
  Chantier: { findByPk: jest.fn() },
  Organisation: { findOne: jest.fn() },
  Utilisateur: { findOne: jest.fn() },
}));

jest.mock('../utils/logger.js', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { Media, Reserve, Chantier } = require('../models/index.js');
const checkFileAccess = require('../middlewares/checkFileAccess.middleware.js');
const { cache } = require('../middlewares/checkFileAccess.middleware.js')._interne;

const ORG = 'org-1';
const AUTRE_ORG = 'org-2';

/** Un appelant authentifié, membre de [organisationId]. */
const compte = (organisationId = ORG, role = 'ChefProjet') => ({
  id: 'u-1',
  email: 'balla@widjila.com',
  role,
  organisationId,
});

/** Joue le middleware et rend l'erreur passée à `next`, ou `null`. */
async function appeler(chemin, user) {
  const req = { method: 'GET', path: chemin, originalUrl: chemin, user };
  const res = { setHeader: jest.fn() };
  let erreur = null;
  await checkFileAccess(req, res, (e) => {
    erreur = e || null;
  });
  return { erreur, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Le middleware met ses résolutions en cache, échecs compris : sans purge,
  // un test hériterait de la réponse du précédent.
  cache.clear();

  Reserve.findByPk.mockResolvedValue({ id: 'r-1', chantierId: 'c-1' });
  Chantier.findByPk.mockResolvedValue({ id: 'c-1', organisationId: ORG });
});

describe('la VIGNETTE d’une photo est servie comme son original', () => {
  it('résout le propriétaire depuis `thumbnail_url`', async () => {
    // Aucune ligne ne porte cette URL dans `url` — c'est une vignette.
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler('/medias/photos/abc_thumb.jpg', compte());

    expect(erreur).toBeNull();
  });

  it('interroge bien les DEUX colonnes', async () => {
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    await appeler('/medias/photos/abc_thumb.jpg', compte());

    const where = Media.findOne.mock.calls[0][0].where;
    const clauses = where[Op.or];
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toHaveProperty('url');
    expect(clauses[1]).toHaveProperty('thumbnail_url');
  });

  it('sert toujours l’ORIGINAL — la correction n’a rien cassé', async () => {
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler('/medias/photos/abc.jpg', compte());

    expect(erreur).toBeNull();
  });
});

describe('le rangement par projet du cahier technique § 5', () => {
  // Les fichiers ne partent plus dans un `medias/` unique mais sous
  // `photos/projet_{id}/reserves/reserve_{id}/`. Sans ces préfixes dans la
  // liste blanche, chaque photo déposée après la mise en service aurait
  // répondu « Fichier introuvable ».
  it.each([
    ['une photo de réserve', '/photos/projet_c-1/reserves/reserve_r-1/abc.jpg'],
    ['sa vignette', '/photos/projet_c-1/reserves/reserve_r-1/abc_thumb.jpg'],
    ['une vidéo', '/videos/projet_c-1/reserves/reserve_r-1/abc.mp4'],
    ['un mémo vocal', '/audios/projet_c-1/reserves/reserve_r-1/abc.m4a'],
    ['un média d’inspection', '/photos/projet_c-1/inspections/inspection_i-1/abc.jpg'],
  ])('sert %s', async (_libelle, chemin) => {
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler(chemin, compte());

    expect(erreur).toBeNull();
  });

  it('sert TOUJOURS les fichiers de l’ancien dossier à plat', async () => {
    // Aucune migration de données n'accompagne le changement : les fichiers
    // déjà en ligne gardent leur chemin, et doivent rester lisibles.
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler('/medias/photos/abc.jpg', compte());

    expect(erreur).toBeNull();
  });

  it('applique le cloisonnement au NOUVEAU rangement aussi', async () => {
    // Le chemin porte désormais l'identifiant du projet en clair : il ne doit
    // surtout pas devenir une autorisation. C'est toujours la ligne en base
    // qui décide.
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler(
      '/photos/projet_c-1/reserves/reserve_r-1/abc.jpg',
      compte(AUTRE_ORG),
    );

    expect(erreur).not.toBeNull();
    expect(erreur.statusCode).toBe(403);
  });
});

describe('le cloisonnement entre organisations n’est pas relâché', () => {
  it('refuse la vignette d’une AUTRE organisation', async () => {
    // Élargir une clause `WHERE` est exactement le genre de correction qui
    // ouvre une fuite si l'on oublie le contrôle qui suit.
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler('/medias/photos/abc_thumb.jpg', compte(AUTRE_ORG));

    expect(erreur).not.toBeNull();
    expect(erreur.statusCode).toBe(403);
  });

  it('refuse un fichier qu’aucune ligne ne référence', async () => {
    // Défaut sûr : sans propriétaire, impossible d'autoriser. 404 et non 403,
    // pour ne pas confirmer l'existence d'un fichier à un tiers.
    Media.findOne.mockResolvedValue(null);

    const { erreur } = await appeler('/medias/photos/devine.jpg', compte());

    expect(erreur).not.toBeNull();
    expect(erreur.statusCode).toBe(404);
  });

  it('laisse passer le super-admin plateforme', async () => {
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { erreur } = await appeler('/medias/photos/abc_thumb.jpg', compte(AUTRE_ORG, 'Admin'));

    expect(erreur).toBeNull();
  });
});

describe('les en-têtes de sécurité restent posés', () => {
  it('interdit le sniffing et la mise en cache partagée', async () => {
    // Un fichier privé ne doit jamais être interprété par le navigateur ni
    // retenu par un intermédiaire.
    Media.findOne.mockResolvedValue({ id: 'm-1', reserveId: 'r-1', inspectionId: null });

    const { res } = await appeler('/medias/photos/abc_thumb.jpg', compte());

    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});
