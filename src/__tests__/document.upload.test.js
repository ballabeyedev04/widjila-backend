'use strict';

/**
 * Tests — dépôt de documents dans la GED d'un chantier.
 *
 * ## Ce qui était cassé
 *
 * `POST /chantiers/:chantierId/documents` utilisait l'instance d'upload
 * générique : 5 Mo et liste blanche PDF / images / médias. Conséquences :
 *   - tout document bureautique (Word, Excel, PowerPoint) et tout plan DWG
 *     était refusé, depuis le web comme depuis le mobile ;
 *   - une vidéo filmée depuis le mobile dépassait le plafond en quelques
 *     secondes et échouait en « Fichier trop volumineux (max 5 MB) ».
 *
 * La route a désormais sa propre instance : formats de GED reconnus par leurs
 * magic bytes, plafond propre à chaque format.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stockage local dans un dossier jetable — jamais Cloudflare R2 en test.
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'ged-test-'));
process.env.UPLOAD_DIR = DOSSIER;
for (const cle of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  process.env[cle] = '';
}

const upload = require('../middlewares/upload.middleware.js');
const { storeFile } = require('../infrastructure/storage.service.js');
const nomFichierOriginal = require('../utils/nomFichierUpload.js');

const { detectType, verifierDocument, validateDocument, MIME_DOCUMENT } = upload;

afterAll(() => fs.rmSync(DOSSIER, { recursive: true, force: true }));

const MO = 1024 * 1024;

/**
 * Archive ZIP minimale : des entrées vides aux noms donnés. Suffisant pour que
 * le catalogue (central directory) soit lisible, ce qui est tout ce que la
 * détection consulte.
 */
function archiveZip(noms) {
  const locaux = [];
  const centraux = [];
  let offset = 0;

  for (const nom of noms) {
    const octetsNom = Buffer.from(nom, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(octetsNom.length, 26);
    locaux.push(local, octetsNom);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(octetsNom.length, 28);
    central.writeUInt32LE(offset, 42);
    centraux.push(central, octetsNom);

    offset += 30 + octetsNom.length;
  }

  const catalogue = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(noms.length, 8);
  fin.writeUInt16LE(noms.length, 10);
  fin.writeUInt32LE(catalogue.length, 12);
  fin.writeUInt32LE(offset, 16);

  return Buffer.concat([...locaux, catalogue, fin]);
}

const docx = () => archiveZip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
const xlsx = () => archiveZip(['[Content_Types].xml', 'xl/workbook.xml']);
const pptx = () => archiveZip(['[Content_Types].xml', 'ppt/presentation.xml']);
const ole2 = () => Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(504)]);
const dwg = () => Buffer.concat([Buffer.from('AC1032', 'ascii'), Buffer.alloc(128)]);

const pdf = (taille = 64) => {
  const b = Buffer.alloc(taille);
  b.write('%PDF-1.7', 0, 'ascii');
  return b;
};

const mp4 = (taille = 64) => {
  const b = Buffer.alloc(taille);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'ascii');
  return b;
};

const fichier = (buffer, mimetype, originalname) => ({ buffer, mimetype, originalname, size: buffer.length });

describe('detectType — formats de GED', () => {
  test.each([
    ['docx', docx],
    ['xlsx', xlsx],
    ['pptx', pptx],
    ['ole2', ole2],
    ['dwg', dwg],
  ])('reconnaît %s', (attendu, fabrique) => {
    expect(detectType(fabrique())).toBe(attendu);
  });

  test("une archive ZIP quelconque n'est pas un document", () => {
    expect(detectType(archiveZip(['script.js']))).toBeNull();
  });

  test('les formats déjà pris en charge restent reconnus', () => {
    expect(detectType(pdf())).toBe('pdf');
    expect(detectType(mp4())).toBe('mp4');
  });
});

describe('verifierDocument', () => {
  test('accepte un Word annoncé sous son propre type', () => {
    expect(verifierDocument(fichier(docx(), MIME_DOCUMENT.docx[0], 'CR chantier.docx')).ok).toBe(true);
  });

  test('accepte un DWG annoncé en type générique, avec la bonne extension', () => {
    expect(verifierDocument(fichier(dwg(), 'application/octet-stream', 'plan-rdc.dwg')).ok).toBe(true);
  });

  test("refuse un type générique dont l'extension ment sur le contenu", () => {
    expect(verifierDocument(fichier(docx(), 'application/octet-stream', 'facture.pdf')).ok).toBe(false);
  });

  test('refuse un type annoncé qui ne correspond pas au contenu', () => {
    expect(verifierDocument(fichier(dwg(), 'application/pdf', 'plan.pdf')).ok).toBe(false);
  });

  test('un OLE2 doit porter une extension Office 97-2003', () => {
    expect(verifierDocument(fichier(ole2(), 'application/msword', 'cr.doc')).ok).toBe(true);
    expect(verifierDocument(fichier(ole2(), 'application/msword', 'outil.exe')).ok).toBe(false);
  });

  test('refuse un contenu non reconnu (HTML déguisé en PDF)', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(verifierDocument(fichier(html, 'application/pdf', 'x.pdf')).ok).toBe(false);
  });

  test('une vidéo de 20 Mo passe, un PDF de 20 Mo non', () => {
    expect(verifierDocument(fichier(mp4(20 * MO), 'video/mp4', 'fissure.mp4')).ok).toBe(true);

    const verdict = verifierDocument(fichier(pdf(20 * MO), 'application/pdf', 'doe.pdf'));
    expect(verdict.ok).toBe(false);
    expect(verdict.raison).toMatch(/volumineux/);
  });
});

describe('validateDocument (middleware)', () => {
  const reponse = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  test('laisse passer un document valide', () => {
    const next = jest.fn();
    validateDocument({ file: fichier(xlsx(), 'application/octet-stream', 'metre.xlsx') }, reponse(), next);
    expect(next).toHaveBeenCalledWith();
  });

  test('répond 400 avec un message explicite sinon', () => {
    const res = reponse();
    const next = jest.fn();
    validateDocument({ file: fichier(Buffer.from('MZ-executable'), 'application/octet-stream', 'setup.exe') }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/setup\.exe/);
  });
});

describe('storeFile — extension dérivée du contenu', () => {
  test.each([
    ['CR.docx', '.docx', docx],
    ['metre.xlsx', '.xlsx', xlsx],
    ['plan.dwg', '.dwg', dwg],
    ['ancien.xls', '.xls', ole2],
    // Un OLE2 sous un nom trompeur n'hérite pas de son extension.
    ['piege.html', '.bin', ole2],
  ])('%s est stocké en %s', async (nom, extension, fabrique) => {
    const reference = await storeFile(fabrique(), nom, 'documents');
    expect(reference.startsWith('/uploads/documents/')).toBe(true);
    expect(path.extname(reference)).toBe(extension);
  });
});

describe('nomFichierOriginal', () => {
  test("rétablit les accents d'un nom UTF-8 lu en latin1", () => {
    const recu = Buffer.from('Procès-verbal réception.pdf', 'utf8').toString('latin1');
    expect(nomFichierOriginal(recu)).toBe('Procès-verbal réception.pdf');
  });

  test('laisse intact un nom déjà correct', () => {
    expect(nomFichierOriginal('café.pdf')).toBe('café.pdf');
    expect(nomFichierOriginal('plan.pdf')).toBe('plan.pdf');
  });

  test('ne garde que le dernier segment et retire les caractères de contrôle', () => {
    const nul = String.fromCharCode(0);
    expect(nomFichierOriginal(`..\\..\\a/b/cr${nul}.docx`)).toBe('cr.docx');
  });

  test("borne la longueur en gardant l'extension", () => {
    const nom = nomFichierOriginal(`${'a'.repeat(400)}.pdf`);
    expect(nom.length).toBeLessThanOrEqual(200);
    expect(nom.endsWith('.pdf')).toBe(true);
  });

  test('un nom vide retombe sur un défaut', () => {
    expect(nomFichierOriginal('')).toBe('document');
  });
});

/**
 * Le gestionnaire global annonçait « max 5 MB » pour tout dépassement de
 * taille — faux pour les imports tableur (2 Mo, 512 Ko) comme pour les médias
 * (100 Mo). Chaque instance répond désormais par son propre plafond.
 */
describe('plafonds de taille annoncés', () => {
  // Chargés ici : `errorHandler` tire la configuration applicative, inutile
  // aux autres blocs de ce fichier.
  const express = require('express');
  const request = require('supertest');
  const errorHandler = require('../middlewares/errorHandler.middleware.js');

  const appAvec = (middleware) => {
    const app = express();
    app.post('/depot', middleware, (req, res) => res.json({ success: true }));
    app.use(errorHandler);
    return app;
  };

  test('un import de membres trop lourd annonce 512 Ko, pas 5 MB', async () => {
    const res = await request(appAvec(upload.tableurUploadContacts.single('fichier')))
      .post('/depot')
      .attach('fichier', Buffer.alloc(600 * 1024, 0x61), { filename: 'membres.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/512 Ko/);
  });

  test('un import Excel trop lourd annonce 2 Mo', async () => {
    const res = await request(appAvec(upload.tableurUpload.single('fichier')))
      .post('/depot')
      .attach('fichier', Buffer.alloc(2.5 * MO, 0x61), { filename: 'reserves.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/2 Mo/);
  });

  test('un fichier dans les limites passe', async () => {
    const res = await request(appAvec(upload.tableurUploadContacts.single('fichier')))
      .post('/depot')
      .attach('fichier', Buffer.from('nom;email\n'), { filename: 'membres.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
  });
});
