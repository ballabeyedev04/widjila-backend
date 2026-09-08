'use strict';

/**
 * Tests — un envoi de média rejoué ne crée pas de doublon.
 *
 * ## Le défaut
 *
 * Le mobile met les photos prises hors ligne dans une file d'attente. Elle ne
 * rejoue une action que si la précédente a ÉCHOUÉ de son point de vue — mais
 * « échoué côté client » ne veut pas dire « échoué côté serveur ».
 *
 * La fenêtre dangereuse : le serveur écrit le média, puis la réponse se perd.
 * Coupure en pleine réponse, délai dépassé sur un réseau de chantier. Le
 * client n'a pas d'acquittement, l'action reste en file, et repart au passage
 * suivant. La même photo se retrouvait DEUX FOIS sur la réserve.
 *
 * Sur un chantier mal couvert, ce n'est pas un cas limite : c'est le mode
 * d'échec ordinaire.
 *
 * ## Pourquoi l'empreinte du contenu
 *
 * `checksum` — une empreinte SHA-256 des octets — était déjà calculée et
 * stockée à chaque envoi, sans jamais servir à rien. Deux fois les mêmes
 * octets sur la même réserve, c'est le même cliché : le second n'apporte
 * aucune information.
 *
 * La création de réserve résolvait déjà ce problème, mais par un identifiant
 * fourni par le client. Ici l'empreinte suffit et ne demande aucun changement
 * de contrat : les clients déjà déployés en bénéficient sans mise à jour.
 *
 * ## L'ordre compte
 *
 * Le contrôle est placé AVANT l'écriture du fichier. Un rejeu ne repaie donc
 * ni le stockage, ni la génération de vignette — ce qu'on veut surtout éviter
 * sur une connexion qui vient d'échouer.
 */

jest.mock('../models/index.js', () => ({
  Media: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
  // `findByPk` en plus de `findOne` : le service remonte désormais au CHANTIER
  // pour ranger le fichier sous `photos/projet_{id}/reserves/reserve_{id}/`
  // (cahier technique § 5).
  Reserve: { findOne: jest.fn(), findByPk: jest.fn() },
  Inspection: { findOne: jest.fn(), findByPk: jest.fn() },
  Chantier: {},
}));

jest.mock('../infrastructure/storage.service.js', () => ({
  storeFile: jest.fn(),
  deleteFile: jest.fn(),
}));

jest.mock('sharp', () => jest.fn(() => ({
  rotate: jest.fn().mockReturnThis(),
  resize: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('vignette')),
})));

const { Media, Reserve, Inspection } = require('../models/index.js');
const { storeFile, deleteFile } = require('../infrastructure/storage.service.js');
const MediaService = require('../modules/media/service/media.service.js');

const RESERVE = 'res-1';

/** Un fichier téléversé, tel que multer le présente. */
const fichier = (contenu = 'octets-de-la-photo') => ({
  buffer: Buffer.from(contenu),
  originalname: 'fissure.jpg',
  mimetype: 'image/jpeg',
});

beforeEach(() => {
  jest.clearAllMocks();
  Media.findOne.mockResolvedValue(null);
  // Le parent du média — il donne le chantier sous lequel le fichier est rangé.
  Reserve.findByPk.mockResolvedValue({ id: 'reserve-1', chantierId: 'chantier-1' });
  Inspection.findByPk.mockResolvedValue({ id: 'inspection-1', chantierId: 'chantier-1' });
  Media.create.mockImplementation(async (v) => ({ id: 'media-neuf', ...v }));
  storeFile.mockResolvedValue('https://stockage.test/photos/fissure.jpg');
  deleteFile.mockResolvedValue(undefined);
});

describe('premier envoi', () => {
  it('stocke le fichier et crée la ligne', async () => {
    const res = await MediaService._enregistrer(RESERVE, null, 'photo', fichier());

    expect(res.success).toBe(true);
    expect(res.rejeu).toBeUndefined();
    // DEUX ecritures de stockage pour une photo : le fichier, puis sa
    // vignette. C'est precisement ce cout que le rejeu doit eviter.
    expect(storeFile).toHaveBeenCalledTimes(2);
    expect(Media.create).toHaveBeenCalledTimes(1);
  });

  it('l’empreinte enregistrée décrit bien le CONTENU', async () => {
    await MediaService._enregistrer(RESERVE, null, 'photo', fichier('AAA'));
    const premiere = Media.create.mock.calls[0][0].checksum;

    Media.create.mockClear();
    await MediaService._enregistrer(RESERVE, null, 'photo', fichier('BBB'));
    const seconde = Media.create.mock.calls[0][0].checksum;

    expect(premiere).toHaveLength(64);
    expect(premiere).not.toBe(seconde);
  });
});

describe('rejeu après une réponse perdue', () => {
  it('ne crée PAS un second média', async () => {
    // Le serveur avait déjà écrit la ligne au premier passage.
    Media.findOne.mockResolvedValue({ id: 'media-existant', reserveId: RESERVE });

    const res = await MediaService._enregistrer(RESERVE, null, 'photo', fichier());

    expect(res.success).toBe(true);
    expect(res.rejeu).toBe(true);
    expect(res.media.id).toBe('media-existant');
    expect(Media.create).not.toHaveBeenCalled();
  });

  it('répond SUCCÈS, pour que la file d’attente se vide', async () => {
    // Le point qui compte pour le mobile : un échec laisserait l'action en
    // file indéfiniment, et l'écran de synchronisation afficherait une erreur
    // pour une photo pourtant bien arrivée.
    Media.findOne.mockResolvedValue({ id: 'media-existant' });

    const res = await MediaService._enregistrer(RESERVE, null, 'photo', fichier());

    expect(res.success).toBe(true);
  });

  it('ne repaie ni le stockage ni la vignette', async () => {
    // Le contrôle vient AVANT l'écriture. Sur une connexion qui vient
    // d'échouer, refaire le téléversement serait exactement ce qu'il ne faut
    // pas faire.
    Media.findOne.mockResolvedValue({ id: 'media-existant' });

    await MediaService._enregistrer(RESERVE, null, 'photo', fichier());

    expect(storeFile).not.toHaveBeenCalled();
  });

  it('la recherche est bornée à la MÊME réserve', async () => {
    // Une photo identique sur une autre réserve est un cliché distinct — deux
    // fissures peuvent se ressembler au point d'octet près si le fichier a été
    // copié. Le rapprochement ne vaut que dans un même parent.
    await MediaService._enregistrer(RESERVE, null, 'photo', fichier());

    const where = Media.findOne.mock.calls[0][0].where;
    expect(where.reserveId).toBe(RESERVE);
    expect(where.checksum).toHaveLength(64);
  });

  it('une INSPECTION est rapprochée sur son propre parent', async () => {
    await MediaService._enregistrer(null, 'insp-1', 'photo', fichier());

    const where = Media.findOne.mock.calls[0][0].where;
    expect(where.inspectionId).toBe('insp-1');
    expect(where.reserveId).toBeUndefined();
  });
});

describe('cas voisins', () => {
  it('un contenu DIFFÉRENT sur la même réserve est bien créé', async () => {
    // La déduplication ne doit pas avaler une seconde photo légitime.
    Media.findOne.mockResolvedValue(null);

    const res = await MediaService._enregistrer(RESERVE, null, 'photo', fichier('autre-cliche'));

    expect(res.rejeu).toBeUndefined();
    expect(Media.create).toHaveBeenCalledTimes(1);
  });

  it('un fichier absent est refusé avant tout accès à la base', async () => {
    const res = await MediaService._enregistrer(RESERVE, null, 'photo', null);

    expect(res.success).toBe(false);
    expect(Media.findOne).not.toHaveBeenCalled();
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('un échec d’écriture nettoie le fichier déjà stocké', async () => {
    // Sans ce nettoyage, le fichier resterait téléchargeable sans qu'aucune
    // ligne ne le référence — donc sans qu'aucun contrôle d'accès ne le
    // couvre.
    Media.create.mockRejectedValue(new Error('contrainte violée'));

    await expect(
      MediaService._enregistrer(RESERVE, null, 'photo', fichier())
    ).rejects.toThrow();

    expect(deleteFile).toHaveBeenCalledWith('https://stockage.test/photos/fissure.jpg');
  });
});
