'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger.js');
const { detectType } = require('../middlewares/upload.middleware.js');
const r2 = require('./r2.service.js');

/**
 * storage.service.js — Stockage des fichiers (photos, vidéos, plans, documents,
 * rapports, pièces jointes).
 *
 * ── OÙ VONT LES FICHIERS ─────────────────────────────────────────────────────
 * Cloudflare R2 dès que les variables R2_* sont configurées ; sinon disque
 * local (développement). Aucun contenu binaire n'est stocké en base : seule la
 * référence l'est.
 *
 * ── DEUX RÉGIMES, DEUX FORMES DE RÉFÉRENCE ───────────────────────────────────
 *
 * PUBLIC — `profils`, `organisations` (photos de profil, logos).
 *   Peu sensibles, affichés partout. Envoyés sous `images/<dossier>/` et
 *   référencés par leur URL publique complète, servie par le CDN Cloudflare
 *   sans passer par l'API.
 *
 * PRIVÉ — `plans`, `documents`, `rapports`, `medias/*`, `pieces`.
 *   Plans d'exécution, DOE, PV signés, photos de réserves. Le bucket reste
 *   privé. La référence conserve la forme `/uploads/<dossier>/<nom>` :
 *     - l'accès passe obligatoirement par le backend
 *       (auth → checkActiveUser → checkFileAccess) ;
 *     - les lignes déjà en base restent valides, aucune migration de données ;
 *     - `checkFileAccess` continue de retrouver la ressource propriétaire en
 *       comparant ce champ, sans modification.
 *   La clé R2 correspondante est simplement la référence privée de son préfixe
 *   `/uploads/`.
 *
 * ── SÉCURITÉ ─────────────────────────────────────────────────────────────────
 * L'extension du fichier stocké est DÉRIVÉE DES MAGIC BYTES (contenu réel),
 * jamais de l'`originalname` fourni par le client : un fichier « x.html » au
 * corps PDF devient `.pdf`, ce qui ferme le XSS stocké.
 */

// Racine des uploads locaux — <racine_projet>/uploads (repli hors R2)
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads');

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

/** Sous-dossiers dont le contenu est servi publiquement par le CDN. */
const DOSSIERS_PUBLICS = new Set(['profils', 'organisations']);

// Extensions sûres autorisées en secours si la détection par magic bytes échoue
const SAFE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.pdf', '.webp',
  '.mp4', '.webm', '.mov', '.mp3', '.m4a', '.ogg', '.wav',
]);
const EXT_BY_TYPE = {
  png: '.png', jpg: '.jpg', pdf: '.pdf', webp: '.webp',
  mp4: '.mp4', webm: '.webm', mov: '.mov',
  mp3: '.mp3', m4a: '.m4a', ogg: '.ogg', wav: '.wav',
};

/** Vrai si ce sous-dossier relève du régime public. */
function estPublic(sousDossier = '') {
  const racine = String(sousDossier).replace(/\\/g, '/').split('/')[0];
  return DOSSIERS_PUBLICS.has(racine);
}

/** Extension déduite du contenu réel, avec repli sur une liste blanche. */
function extensionSure(buffer, originalname) {
  const typeReel = detectType(buffer);
  if (typeReel && EXT_BY_TYPE[typeReel]) return EXT_BY_TYPE[typeReel];

  const extOrig = path.extname(originalname || '').toLowerCase();
  return SAFE_EXTS.has(extOrig) ? extOrig : '.bin';
}

/**
 * Enregistre un buffer et retourne la référence à stocker en base.
 *
 * @param {Buffer} buffer — contenu du fichier (multer memoryStorage)
 * @param {string} originalname — nom original (info + repli d'extension)
 * @param {string} [sousDossier] — plans, documents, rapports, medias/photos, profils…
 * @returns {Promise<string>} URL publique (régime public) ou `/uploads/…` (privé)
 */
async function storeFile(buffer, originalname, sousDossier = '') {
  const ext = extensionSure(buffer, originalname);
  const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

  // Normalisation POSIX : `path.join` utiliserait le séparateur de l'OS, ce qui
  // produirait des clés R2 avec des antislashs sous Windows.
  const dossier = String(sousDossier).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const chemin = dossier ? `${dossier}/${unique}` : unique;
  const publique = estPublic(dossier);

  // ── Cloudflare R2 ──────────────────────────────────────────────────────────
  if (r2.estConfigure()) {
    const cle = publique ? `images/${chemin}` : chemin;
    await r2.upload(buffer, cle, unique);

    if (publique) {
      const url = r2.urlPublique(cle);
      logger.info(`[storage] Fichier public envoyé sur R2 : ${cle}`);
      // Sans R2_PUBLIC_URL configurée, on ne peut pas fabriquer d'URL publique :
      // on retombe sur la forme privée, servie par le backend.
      if (url) return url;
      return `/uploads/${chemin}`;
    }

    logger.info(`[storage] Fichier privé envoyé sur R2 : ${cle}`);
    return `/uploads/${chemin}`;
  }

  // ── Repli disque local (développement) ─────────────────────────────────────
  const absDir = path.join(UPLOAD_DIR, ...dossier.split('/').filter(Boolean));
  const absPath = path.join(absDir, unique);

  await fsp.mkdir(absDir, { recursive: true });
  await fsp.writeFile(absPath, buffer);

  logger.info(`[storage] Fichier enregistré localement : ${absPath}`);
  return `/uploads/${chemin}`;
}

/**
 * Supprime un fichier — best-effort, ne doit jamais faire échouer l'action métier.
 * Gère les trois formes de référence : URL publique R2, chemin `/uploads/…`
 * (R2 ou disque), et les fichiers hérités du stockage local.
 *
 * @param {string} reference — valeur telle que stockée en base
 */
async function deleteFile(reference) {
  if (!reference) return;

  // 1. Objet R2 (URL publique ou chemin /uploads/ converti en clé)
  if (r2.estConfigure()) {
    const cle = r2.versCle(reference);
    // Le régime public préfixe les clés par `images/` — versCle() le conserve
    // puisqu'il ne retire que l'origine ou `/uploads/`.
    if (cle) await r2.supprimer(cle);
  }

  // 2. Fichier local (déploiement hors R2, ou fichier antérieur à la migration)
  if (!reference.startsWith('/uploads/')) return;
  const rel = reference.slice('/uploads/'.length);
  // Anti path traversal : pas de remontée de répertoire, pas de chemin absolu
  if (rel.includes('..') || path.isAbsolute(rel) || path.posix.isAbsolute(rel)) {
    logger.warn(`[storage] Suppression refusée (chemin suspect) : ${reference}`);
    return;
  }
  const absPath = path.join(UPLOAD_DIR, ...rel.split('/').filter(Boolean));
  try {
    await fsp.unlink(absPath);
    logger.info(`[storage] Fichier local supprimé : ${absPath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[storage] Suppression locale impossible : ${err.message}`);
  }
}

/**
 * Ouvre un fichier privé en lecture, pour le middleware de service `/uploads`.
 * Tente R2 d'abord, puis le disque local — de sorte que les fichiers déposés
 * avant la bascule restent lisibles sans migration.
 *
 * @param {string} reference — chemin `/uploads/…` ou clé R2
 * @returns {Promise<{stream, contentType, taille}|null>} null si introuvable
 */
async function ouvrirFichier(reference) {
  if (!reference) return null;

  if (r2.estConfigure()) {
    try {
      return await r2.getStream(reference);
    } catch (err) {
      // Objet absent de R2 → on tente le disque (fichier hérité).
      logger.info(`[storage] Absent de R2, tentative locale : ${reference} (${err.name || err.message})`);
    }
  }

  const rel = String(reference).replace(/^\/?uploads\//, '');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;

  const absPath = path.join(UPLOAD_DIR, ...rel.split('/').filter(Boolean));
  try {
    const stat = await fsp.stat(absPath);
    return {
      stream: fs.createReadStream(absPath),
      contentType: r2.contentType(absPath),
      taille: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * URL signée temporaire pour un fichier privé (cahier des charges : « liens de
 * téléchargement temporaires et signés »). Null si R2 n'est pas configuré.
 */
async function urlTemporaire(reference, expiresIn = 3600) {
  if (!r2.estConfigure()) return null;
  try {
    return await r2.urlSignee(reference, expiresIn);
  } catch (err) {
    logger.warn(`[storage] URL signée impossible : ${err.message}`);
    return null;
  }
}

/** Crée le dossier uploads local au démarrage (repli hors R2). */
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

module.exports = {
  storeFile,
  deleteFile,
  ouvrirFichier,
  urlTemporaire,
  ensureUploadDir,
  estPublic,
  UPLOAD_DIR,
  PUBLIC_BASE,
};
