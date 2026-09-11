'use strict';

/**
 * Deuxième audit synchronisation — A2-07 : deux envois SIMULTANÉS de la même
 * photo créaient deux médias.
 *
 * La déduplication par empreinte (voir media.rejeuHorsLigne.test.js) lit
 * AVANT d'écrire, sans verrou ni contrainte d'unicité. Le cas se produit pour
 * de vrai : un envoi en ligne dépasse son délai pendant que le serveur stocke
 * encore la vidéo, le mobile met la photo en file, et la file la rejoue 400 ms
 * plus tard — les deux requêtes passent la vérification avant que l'une ou
 * l'autre n'ait écrit.
 */

jest.mock('../config/db.js', () => ({ transaction: jest.fn(), query: jest.fn() }));

const mockMedias = [];
jest.mock('../models/index.js', () => ({
  Media: {
    findOne: jest.fn(async ({ where }) => mockMedias.find((m) => m.reserveId === where.reserveId && m.checksum === where.checksum) || null),
    create: jest.fn(async (v) => {
      const m = { id: `m-${mockMedias.length + 1}`, ...v };
      mockMedias.push(m);
      return m;
    }),
  },
  Reserve: { findByPk: jest.fn(async () => ({ id: 'res-1', chantierId: 'ch-1' })), update: jest.fn(async () => [1]) },
  Inspection: { findByPk: jest.fn() },
  Chantier: {},
  ReserveAffectation: {},
}));

jest.mock('../infrastructure/storage.service.js', () => ({
  // Un stockage LENT, comme un envoi vers R2 : c'est la fenêtre de la course.
  storeFile: jest.fn(async (buffer, nom) => {
    await new Promise((r) => setTimeout(r, 30));
    return `https://stockage.test/${nom}`;
  }),
  deleteFile: jest.fn(),
}));

jest.mock('sharp', () => jest.fn(() => ({
  rotate: jest.fn().mockReturnThis(),
  resize: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('vignette')),
})));

jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const sequelize = require('../config/db.js');
const { Media } = require('../models/index.js');
const MediaService = require('../modules/media/service/media.service.js');

/** Verrous consultatifs de TRANSACTION, simulés : un par clé, rendus au commit. */
function brancherVerrousConsultatifs() {
  const files = new Map();
  sequelize.transaction.mockImplementation(async (rappel) => {
    const t = { liberations: [] };
    try {
      return await rappel(t);
    } finally {
      t.liberations.forEach((l) => l());
    }
  });
  sequelize.query.mockImplementation(async (sql, { replacements, transaction }) => {
    const cle = replacements.cle;
    const precedent = files.get(cle) || Promise.resolve();
    let liberer;
    const suivant = new Promise((r) => { liberer = r; });
    files.set(cle, precedent.then(() => suivant));
    await precedent;
    transaction.liberations.push(liberer);
    return [{}];
  });
}

const fichier = () => ({ buffer: Buffer.from('octets-identiques'), originalname: 'fissure.jpg', mimetype: 'image/jpeg' });

beforeEach(() => {
  jest.clearAllMocks();
  mockMedias.length = 0;
  brancherVerrousConsultatifs();
});

it('deux envois simultanés du même contenu : UN seul média', async () => {
  const [a, b] = await Promise.all([
    MediaService._enregistrer('res-1', null, 'photo', fichier()),
    MediaService._enregistrer('res-1', null, 'photo', fichier()),
  ]);

  expect(a.success && b.success).toBe(true);
  expect(mockMedias).toHaveLength(1);
  expect(Media.create).toHaveBeenCalledTimes(1);
  expect([a.rejeu, b.rejeu].filter(Boolean)).toHaveLength(1);
});

it('deux contenus DIFFÉRENTS envoyés en même temps : deux médias, sans attente mutuelle inutile', async () => {
  await Promise.all([
    MediaService._enregistrer('res-1', null, 'photo', { ...fichier(), buffer: Buffer.from('A') }),
    MediaService._enregistrer('res-1', null, 'photo', { ...fichier(), buffer: Buffer.from('B') }),
  ]);

  expect(mockMedias).toHaveLength(2);
});

it('le verrou porte sur le parent ET l’empreinte', async () => {
  await MediaService._enregistrer('res-1', null, 'photo', fichier());

  const [sql, options] = sequelize.query.mock.calls[0];
  expect(sql).toMatch(/pg_advisory_xact_lock/);
  expect(options.replacements.cle).toMatch(/^media:reserve:res-1:[0-9a-f]{64}$/);
});
