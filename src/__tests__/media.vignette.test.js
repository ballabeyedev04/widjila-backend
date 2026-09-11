'use strict';

/**
 * Tests — génération de la vignette à l'envoi d'une photo.
 *
 * ## Ce qui s'était cassé
 *
 * La colonne `thumbnail_url` existait et TROIS consommateurs la lisaient déjà,
 * chacun derrière un repli `thumbnail_url || url`. Rien ne l'écrivait jamais :
 * le repli était donc le seul chemin réellement emprunté, et personne ne s'en
 * apercevait puisque l'affichage restait correct — seulement beaucoup plus
 * lourd.
 *
 * Conséquences mesurables : la grille de photos d'une réserve téléchargeait
 * l'original (plusieurs Mo d'un appareil photo de téléphone) pour l'afficher
 * sur 104 points, et le générateur de rapports PDF chargeait chaque original
 * entier en mémoire serveur.
 */

jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: jest.fn(),
  deleteFile: jest.fn(),
}));

// `_enregistrer` pose un verrou consultatif de transaction autour de
// « revérifier puis créer » (A2-07) : sans base, la transaction exécute
// simplement son travail.
jest.mock('../config/db.js', () => ({
  transaction: jest.fn(async (travail) => travail({})),
  query: jest.fn(async () => [{}]),
}));

jest.mock('../models/index.js', () => ({
  Media: { create: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
  Reserve: { findByPk: jest.fn() },
  Inspection: { findByPk: jest.fn() },
  Chantier: { findByPk: jest.fn() },
}));

const sharp = require('sharp');
const { storeFile } = require('../infrastructure/storage.service.js');
const MediaService = require('../modules/media/service/media.service.js');

/** JPEG réel de `largeur`×`hauteur`, pour que `sharp` ait de quoi travailler. */
const imageJpeg = (largeur, hauteur) =>
  sharp({ create: { width: largeur, height: hauteur, channels: 3, background: '#7a7a7a' } })
    .jpeg()
    .toBuffer();

describe('_vignette', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeFile.mockResolvedValue('/uploads/medias/photos/vignette.jpg');
  });

  it('réduit une photo d’appareil à 400 px de large', async () => {
    const original = await imageJpeg(3000, 2000);

    await MediaService._vignette(original, 'photo.jpg', 'medias/photos');

    expect(storeFile).toHaveBeenCalledTimes(1);
    const [buffer] = storeFile.mock.calls[0];
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400);
    expect(buffer.length).toBeLessThan(original.length);
  });

  it('n’AGRANDIT pas une image déjà petite', async () => {
    // Agrandir produirait un fichier plus lourd que l'original : l'inverse de
    // ce qu'on cherche.
    const petite = await imageJpeg(120, 90);

    await MediaService._vignette(petite, 'petite.jpg', 'medias/photos');

    const [buffer] = storeFile.mock.calls[0];
    expect((await sharp(buffer).metadata()).width).toBe(120);
  });

  it('rend null sans faire échouer quoi que ce soit quand le fichier n’est pas une image', async () => {
    // Une note vocale ou une vidéo mal aiguillée ne doit pas empêcher
    // l'enregistrement : tous les consommateurs savent retomber sur l'original.
    const resultat = await MediaService._vignette(Buffer.from('ceci n est pas une image'), 'x.jpg', 'medias/photos');

    expect(resultat).toBeNull();
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('rend null si le stockage refuse la vignette, sans propager l’erreur', async () => {
    storeFile.mockRejectedValue(new Error('R2 indisponible'));
    const original = await imageJpeg(800, 600);

    await expect(MediaService._vignette(original, 'photo.jpg', 'medias/photos')).resolves.toBeNull();
  });

  it('applique l’orientation EXIF : une photo portrait ne ressort pas couchée', async () => {
    // `sharp` lit les pixels bruts et ignore l'étiquette d'orientation que les
    // visionneuses honorent. Sans `rotate()`, les photos prises en portrait
    // ressortaient à l'horizontale.
    // Pixels stockés en PAYSAGE + orientation 6 : c'est exactement ce que
    // produit un téléphone tenu à la verticale. Les pixels ne bougent pas,
    // seule l'étiquette dit comment les présenter.
    const portraitCouche = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#333' },
    })
      .withMetadata({ orientation: 6 }) // 6 = rotation de 90° à appliquer
      .jpeg()
      .toBuffer();

    await MediaService._vignette(portraitCouche, 'portrait.jpg', 'medias/photos');

    const [buffer] = storeFile.mock.calls[0];
    const meta = await sharp(buffer).metadata();
    expect(meta.height).toBeGreaterThan(meta.width);
  });
});
