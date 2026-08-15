'use strict';

const path = require('path');
const multer = require('multer');
const { uploadConfig } = require('../config/security.js');
const { BadRequestError } = require('../errors/AppError.js');

/**
 * Détecte le type réel du fichier depuis ses magic bytes (indépendant du
 * Content-Type annoncé par le client — seule source de confiance).
 * @returns {'png'|'jpg'|'pdf'|'webp'|null}
 */
function detectType(buffer) {
  if (!buffer || buffer.length < 4) return null;

  // PNG : 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  // JPEG : FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  // PDF : 25 50 44 46 (%PDF)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf';
  // Conteneurs RIFF : "RIFF" + 4 octets de taille + identifiant de format
  if (buffer.length >= 12
      && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    const format = buffer.toString('ascii', 8, 12);
    if (format === 'WEBP') return 'webp';
    if (format === 'WAVE') return 'wav';
  }

  // ── Vidéos et notes vocales (module 5 : « photos, vidéos, notes vocales ») ──
  // Le modèle Media, l'ENUM ('photo','video','audio') et les sous-dossiers
  // existaient déjà, mais aucun de ces formats ne passait la détection : la
  // fonctionnalité était inatteignable.

  // MP4 / MOV / M4A : boîte ISO-BMFF « ftyp » à l'octet 4, la marque de
  // format suit immédiatement (isom, mp42, qt__, M4A_…).
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const marque = buffer.toString('ascii', 8, 12);
    if (marque.startsWith('qt')) return 'mov';
    if (marque.startsWith('M4A')) return 'm4a';
    return 'mp4';
  }

  // WebM / Matroska : en-tête EBML 1A 45 DF A3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return 'webm';
  }

  // OGG / Opus : "OggS"
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'ogg';
  }

  // MP3 : tag ID3 ("ID3") ou trame MPEG brute (FF Ex/Fx)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'mp3';
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return 'mp3';

  return null;
}

const MIME_BY_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  webp: 'image/webp',
  // Vidéos
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // Audio (notes vocales)
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/**
 * Vérifie les magic bytes (signature binaire) du fichier.
 * Protège contre les exécutables déguisés en image/PDF/WebP.
 */
function checkMagicBytes(buffer, mimetype) {
  const type = detectType(buffer);
  if (!type) return false;
  return mimetype === MIME_BY_TYPE[type];
}

// ── Analyse d'archive ZIP (anti « bombe zip » sur l'import Excel) ───────────
//
// CAUSE DU CORRECTIF : l'ancienne version de checkTableurMagic() retournait
// `true` dès qu'un fichier commençait par "PK\x03\x04", SANS regarder le
// mimetype déclaré ni l'extension. Toute archive ZIP passait donc le contrôle,
// et ExcelJS la décompressait ensuite intégralement en mémoire, sans plafond :
// un fichier de quelques ko conçu pour se décompresser en plusieurs Go (bombe
// zip) suffisait à faire tomber le process sur OOM.
//
// On vérifie désormais TROIS choses cohérentes entre elles :
//   1. la signature binaire réelle,
//   2. le mimetype déclaré par le client,
//   3. l'extension du nom de fichier d'origine,
// puis on inspecte le CATALOGUE de l'archive (central directory) pour refuser
// les taux de décompression et volumes aberrants avant qu'ExcelJS n'y touche.

// Un classeur d'import légitime tient très largement sous ces bornes.
const ZIP_MAX_ENTREES = 512;                       // un .xlsx courant : < 50 entrées
const ZIP_MAX_DECOMPRESSE = 64 * 1024 * 1024;      // 64 MB décompressés au total
const ZIP_MAX_RATIO = 300;                         // décompressé / compressé

const SIG_EOCD = 0x06054b50;   // End Of Central Directory
const SIG_CD = 0x02014b50;     // entrée du Central Directory
const TAILLE_ZIP64 = 0xFFFFFFFF;

/**
 * Localise l'End Of Central Directory (fin de l'archive, commentaire compris).
 * @returns {number} offset, ou -1
 */
function trouverEocd(buffer) {
  const maxCommentaire = 0xFFFF;
  const debut = Math.max(0, buffer.length - (maxCommentaire + 22));
  for (let i = buffer.length - 22; i >= debut; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Inspecte le catalogue d'une archive ZIP et décide si sa décompression est
 * raisonnable. Aucune décompression n'est effectuée ici.
 * @returns {{ ok: boolean, raison?: string }}
 */
function analyserArchiveZip(buffer) {
  const eocd = trouverEocd(buffer);
  if (eocd < 0) return { ok: false, raison: 'archive illisible (catalogue ZIP introuvable)' };

  const nbEntrees = buffer.readUInt16LE(eocd + 10);
  const tailleCd = buffer.readUInt32LE(eocd + 12);
  const offsetCd = buffer.readUInt32LE(eocd + 16);

  // ZIP64 : volumes hors de proportion avec un classeur d'import.
  if (nbEntrees === 0xFFFF || tailleCd === TAILLE_ZIP64 || offsetCd === TAILLE_ZIP64) {
    return { ok: false, raison: 'archive ZIP64 refusée' };
  }
  if (nbEntrees > ZIP_MAX_ENTREES) {
    return { ok: false, raison: `archive à ${nbEntrees} entrées (max ${ZIP_MAX_ENTREES})` };
  }
  if (offsetCd + tailleCd > buffer.length) {
    return { ok: false, raison: 'catalogue ZIP incohérent (offsets hors fichier)' };
  }

  let position = offsetCd;
  let totalCompresse = 0;
  let totalDecompresse = 0;

  for (let i = 0; i < nbEntrees; i++) {
    if (position + 46 > buffer.length) return { ok: false, raison: 'catalogue ZIP tronqué' };
    if (buffer.readUInt32LE(position) !== SIG_CD) return { ok: false, raison: 'catalogue ZIP corrompu' };

    const compresse = buffer.readUInt32LE(position + 20);
    const decompresse = buffer.readUInt32LE(position + 24);
    if (compresse === TAILLE_ZIP64 || decompresse === TAILLE_ZIP64) {
      return { ok: false, raison: 'entrée ZIP64 refusée' };
    }

    totalCompresse += compresse;
    totalDecompresse += decompresse;
    if (totalDecompresse > ZIP_MAX_DECOMPRESSE) {
      return { ok: false, raison: `volume décompressé annoncé > ${ZIP_MAX_DECOMPRESSE / (1024 * 1024)} MB` };
    }

    const longueurNom = buffer.readUInt16LE(position + 28);
    const longueurExtra = buffer.readUInt16LE(position + 30);
    const longueurCommentaire = buffer.readUInt16LE(position + 32);
    position += 46 + longueurNom + longueurExtra + longueurCommentaire;
  }

  if (totalCompresse > 0 && totalDecompresse / totalCompresse > ZIP_MAX_RATIO) {
    return { ok: false, raison: `taux de compression suspect (${Math.round(totalDecompresse / totalCompresse)}:1)` };
  }

  return { ok: true };
}

// Extensions admises par type réel détecté.
const EXTENSIONS_TABLEUR = {
  xlsx: ['.xlsx'],
  xls: ['.xls'],
  csv: ['.csv', '.txt'],
};

// Mimetypes admis par type réel détecté. 'application/octet-stream' reste
// toléré (certains navigateurs et clients mobiles ne devinent pas le type),
// mais il ne suffit plus à lui seul : l'extension doit alors trancher.
const MIME_TABLEUR = {
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
  xls: ['application/vnd.ms-excel', 'application/octet-stream'],
  csv: ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
};

/**
 * Vérifie un fichier tableur/CSV : signature binaire, mimetype déclaré et
 * extension doivent désigner LE MÊME format, et une archive doit se
 * décompresser dans des proportions raisonnables.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype     — Content-Type annoncé par le client
 * @param {string} originalname — nom de fichier d'origine (pour l'extension)
 * @returns {{ ok: boolean, raison?: string }}
 */
function checkTableurMagic(buffer, mimetype, originalname = '') {
  if (!buffer || buffer.length < 8) return { ok: false, raison: 'fichier vide ou tronqué' };

  const ext = path.extname(originalname || '').toLowerCase();

  // XLSX = archive ZIP
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (!EXTENSIONS_TABLEUR.xlsx.includes(ext)) {
      return { ok: false, raison: `contenu ZIP/XLSX mais extension "${ext || '(aucune)'}" — .xlsx attendu` };
    }
    if (!MIME_TABLEUR.xlsx.includes(mimetype)) {
      return { ok: false, raison: `contenu ZIP/XLSX mais type déclaré "${mimetype}"` };
    }
    return analyserArchiveZip(buffer);
  }

  // XLS (OLE2)
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) {
    if (!EXTENSIONS_TABLEUR.xls.includes(ext)) {
      return { ok: false, raison: `contenu XLS mais extension "${ext || '(aucune)'}" — .xls attendu` };
    }
    if (!MIME_TABLEUR.xls.includes(mimetype)) {
      return { ok: false, raison: `contenu XLS mais type déclaré "${mimetype}"` };
    }
    return { ok: true };
  }

  // CSV / texte : pas d'octet NUL, extension et mimetype cohérents.
  if (EXTENSIONS_TABLEUR.csv.includes(ext) && MIME_TABLEUR.csv.includes(mimetype)) {
    const echantillon = buffer.subarray(0, 4096);
    for (let i = 0; i < echantillon.length; i++) {
      if (echantillon[i] === 0x00) return { ok: false, raison: 'contenu binaire déguisé en CSV' };
    }
    return { ok: true };
  }

  return { ok: false, raison: 'format non reconnu (formats acceptés : .xlsx, .xls, .csv)' };
}

/**
 * CAUSE DU BUG CORRIGÉ (ici et dans tableurFilter) : multer propage tel quel
 * l'objet passé à `cb()` vers `next(err)`. Un `new Error(...)` nu n'est ni un
 * `AppError`, ni une `MulterError`, ni une erreur Sequelize ou JWT : il
 * traversait tous les branchements d'`errorHandler.middleware.js` pour tomber
 * dans le fourre-tout final → HTTP 500 « Erreur interne du serveur ». Le client
 * recevait donc un « bug serveur » alors qu'il s'agit d'une saisie invalide de
 * sa part, et le message utile était masqué en production.
 *
 * `BadRequestError` (src/errors/AppError.js) porte `statusCode = 400` et
 * `isOperational = true` : c'est exactement la condition testée en premier par
 * `errorHandler` (`err instanceof AppError && err.isOperational`), qui répond
 * alors 400 avec le message métier.
 */
const fileFilter = (req, file, cb) => {
  if (!uploadConfig.allowedMimeTypes.includes(file.mimetype)) {
    return cb(new BadRequestError(`Type de fichier non autorisé : ${file.mimetype}`), false);
  }
  cb(null, true);
};

// memoryStorage : fichier en RAM uniquement, jamais écrit sur disque
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadConfig.maxFileSize },
  fileFilter
});

// ── Uploads tableur (import contacts CSV, import/export réserves Excel) ─────
const TABLEUR_MIME = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];

// Même correctif que fileFilter ci-dessus : erreur métier 400 et non 500.
const tableurFilter = (req, file, cb) => {
  if (!TABLEUR_MIME.includes(file.mimetype)) {
    return cb(
      new BadRequestError(
        `Type de fichier tableur non autorisé : ${file.mimetype}. Formats acceptés : .xlsx, .xls, .csv.`
      ),
      false
    );
  }
  cb(null, true);
};

/**
 * CAUSE DU CORRECTIF (taille) : la limite était de 10 MB pour TOUTES les
 * importations. Un CSV de 10 MB représente ≈ 1,5 million de lignes, et
 * `POST /organisation/membres/import` déclenche pour CHAQUE ligne un SELECT
 * puis un `bcrypt.hash` à 12 rounds — en JS pur (bcryptjs, pas de binding
 * natif). À ~300 ms par hash, une seule requête occupait le CPU pendant
 * plusieurs jours, bloquant l'event loop et donc toute l'API.
 *
 * On sépare désormais deux plafonds :
 *   - tableurUpload         : 2 MB  — import/export Excel des réserves
 *                             (pas de bcrypt, mais décompression ExcelJS)
 *   - tableurUploadContacts : 512 KB — import de membres (bcrypt par ligne),
 *                             soit ≈ 5 000 lignes maximum côté transport.
 *
 * ⚠️ La taille de fichier ne borne PAS le nombre de lignes de façon fiable
 * (un CSV très étroit reste dense). Le plafond de lignes doit être appliqué
 * dans le service d'import — voir le rapport de correctifs.
 */
const TAILLE_MAX_TABLEUR = 2 * 1024 * 1024;
const TAILLE_MAX_CONTACTS = 512 * 1024;

const tableurUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_TABLEUR, files: 1, fields: 20 },
  fileFilter: tableurFilter,
});

// Import de contacts : plafond nettement plus bas (coût bcrypt par ligne).
const tableurUploadContacts = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_CONTACTS, files: 1, fields: 20 },
  fileFilter: tableurFilter,
});

/**
 * Middleware à enchaîner après upload.fields() / upload.single().
 * Valide les magic bytes de chaque fichier uploadé.
 */
const validateMagicBytes = (req, res, next) => {
  const allFiles = [
    ...Object.values(req.files || {}).flat(),
    ...(req.file ? [req.file] : [])
  ];

  for (const file of allFiles) {
    if (!checkMagicBytes(file.buffer, file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: `Fichier invalide : "${file.originalname}". Le contenu ne correspond pas au type déclaré.`
      });
    }
  }
  next();
};

/**
 * Middleware à enchaîner après tableurUpload.single('fichier').
 * Valide la cohérence signature / mimetype / extension du fichier tableur
 * et refuse les archives à taux de décompression aberrant (audit M12 + bombe zip).
 */
const validateTableurMagicBytes = (req, res, next) => {
  if (!req.file) return next();

  const verdict = checkTableurMagic(req.file.buffer, req.file.mimetype, req.file.originalname);
  if (!verdict.ok) {
    return res.status(400).json({
      success: false,
      message: `Fichier invalide : "${req.file.originalname}" — ${verdict.raison}.`
    });
  }
  next();
};

/**
 * Instance dédiée aux médias de réserve (photos, VIDÉOS, notes vocales).
 *
 * Une vidéo de chantier dépasse largement les 5 Mo des documents : sans ce
 * plafond distinct, il aurait fallu relever la limite pour TOUS les uploads,
 * y compris ceux qui n'en ont pas besoin. Même liste blanche MIME et même
 * validation par magic bytes — seule la taille change.
 */
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadConfig.maxMediaSize, files: 1 },
  fileFilter,
});

module.exports = upload;
module.exports.media = uploadMedia;
module.exports.validateMagicBytes = validateMagicBytes;
module.exports.validateTableurMagicBytes = validateTableurMagicBytes;
module.exports.tableurUpload = tableurUpload;
module.exports.tableurUploadContacts = tableurUploadContacts;
module.exports.detectType = detectType;
module.exports.MIME_BY_TYPE = MIME_BY_TYPE;
module.exports.checkTableurMagic = checkTableurMagic;
module.exports.analyserArchiveZip = analyserArchiveZip;
module.exports.TAILLE_MAX_TABLEUR = TAILLE_MAX_TABLEUR;
module.exports.TAILLE_MAX_CONTACTS = TAILLE_MAX_CONTACTS;
