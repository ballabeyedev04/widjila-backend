'use strict';

const { Op } = require('sequelize');
const logger = require('../utils/logger.js');
const { ForbiddenError, NotFoundError, BadRequestError } = require('../errors/AppError.js');
const {
  Plan, Document, Rapport, Media, PieceJointe,
  Reserve, Inspection, Chantier, Organisation, Utilisateur,
} = require('../models/index.js');

/**
 * checkFileAccess.middleware.js — Autorisation d'accès aux fichiers de /uploads.
 *
 * ── Cause du correctif ──────────────────────────────────────────────────────
 * `app.js` servait les uploads derrière `[auth, checkActiveUser, express.static]`.
 * Le contrôle s'arrêtait donc à « authentifié et non désactivé » : AUCUNE
 * vérification d'appartenance. Tout compte actif, TOUTES ORGANISATIONS
 * CONFONDUES, pouvait télécharger n'importe quel PV signé, plan, DOE, photo de
 * réserve ou rapport dès qu'il en connaissait le chemin — chemin qui fuite
 * facilement (URL partagée, cache navigateur, capture d'écran, export PDF,
 * réponse d'API d'un autre chantier…). Aucun accès n'était par ailleurs
 * journalisé, alors que le cahier des charges l'exige.
 *
 * Ce middleware retrouve, à partir du chemin demandé, la LIGNE PROPRIÉTAIRE en
 * base, remonte jusqu'à l'organisation, et refuse tout ce qui n'appartient pas
 * à l'organisation de `req.user`.
 *
 * ── Décisions prises (à valider fonctionnellement) ──────────────────────────
 * 1. PHOTOS DE PROFIL (`/uploads/profils/…`) : accessibles aux membres de la
 *    MÊME organisation que l'utilisateur photographié. C'est le comportement
 *    attendu (trombinoscope, avatar dans les fils de commentaires, listes de
 *    membres) et cela reste conforme à l'isolation multi-tenant. Un utilisateur
 *    d'une autre organisation ne voit plus les avatars.
 * 2. ORPHELINS : un fichier présent sur le disque mais qu'AUCUNE ligne ne
 *    référence est REFUSÉ (404). C'est le défaut sûr — sans ligne, il est
 *    impossible de déterminer un propriétaire, donc impossible d'autoriser.
 *    Concerné : reliquats d'uploads interrompus, fichiers déposés manuellement,
 *    et tout chemin deviné par un attaquant.
 * 3. SOUS-DOSSIER INCONNU : refusé (404). La liste blanche ci-dessous est la
 *    seule surface servie.
 * 4. RESSOURCE SUPPRIMÉE LOGIQUEMENT (`paranoid`) : la résolution du
 *    propriétaire se fait avec `paranoid: false`. Objectif : toujours pouvoir
 *    DÉTERMINER l'organisation propriétaire, donc toujours pouvoir refuser les
 *    autres. Le fichier reste lisible par sa propre organisation — aucun
 *    service n'effectue aujourd'hui de purge physique (`deleteFile` n'est
 *    appelé nulle part), le fichier existe donc de toute façon sur le disque ;
 *    la faille fermée ici est la fuite INTER-organisation.
 * 5. `Admin` (super-admin plateforme) : accès à tout, comme partout ailleurs
 *    (`requireRole`, `checkOrganisation`). L'accès reste journalisé.
 *
 * ── Limite résiduelle assumée ───────────────────────────────────────────────
 * Le contrôle est au niveau ORGANISATION, pas au niveau chantier : un membre de
 * l'organisation qui n'est pas affecté au chantier peut encore lire ses
 * fichiers. C'est exactement la granularité appliquée par le reste du code
 * (`checkOrganisation.middleware.js`, tous les services `list*(organisationId…)`)
 * — durcir davantage ici désaligerait /uploads du reste de l'API.
 */

// ── Cache de résolution ─────────────────────────────────────────────────────
// Une page qui affiche 40 vignettes déclenche 40 requêtes /uploads : sans cache,
// chacune coûterait 2 SELECT. Le cache est volontairement court (les droits
// changent rarement, mais on ne veut pas geler une révocation trop longtemps).
const TTL_POSITIF_MS = 5 * 60 * 1000;
const TTL_NEGATIF_MS = 60 * 1000; // cache aussi les échecs : anti-énumération
const CACHE_MAX = 5000;
const cache = new Map();

function lireCache(cle) {
  const entree = cache.get(cle);
  if (!entree) return undefined;
  if (entree.expire < Date.now()) {
    cache.delete(cle);
    return undefined;
  }
  return entree.valeur;
}

function ecrireCache(cle, valeur) {
  if (cache.size >= CACHE_MAX) {
    // Éviction FIFO simple : les Map JS conservent l'ordre d'insertion.
    const plusAncienne = cache.keys().next().value;
    cache.delete(plusAncienne);
  }
  cache.set(cle, {
    valeur,
    expire: Date.now() + (valeur ? TTL_POSITIF_MS : TTL_NEGATIF_MS),
  });
}

// ── Normalisation du chemin ─────────────────────────────────────────────────

/**
 * Construit les variantes d'URL susceptibles d'être stockées en base.
 *
 * `storage.service.js` fabrique l'URL avec
 *   `path.posix.join('/uploads', path.join(sousDossier), nomUnique)`.
 * Le `path.join()` intermédiaire utilise le séparateur de l'OS : sur Windows,
 * un sous-dossier à deux niveaux ('medias/photos', 'reserves/pieces') est
 * enregistré avec un ANTISLASH ('/uploads/medias\photos/x.jpg') alors qu'il
 * l'est avec un slash sous Linux. On interroge donc les deux formes, sinon la
 * résolution échouerait (et refuserait tout) selon l'OS de production.
 */
function variantesUrl(cheminRelatif) {
  const variantes = new Set([`/uploads/${cheminRelatif}`]);
  const segments = cheminRelatif.split('/');
  if (segments.length > 2) {
    const fichier = segments.pop();
    variantes.add(`/uploads/${segments.join('\\')}/${fichier}`);
  }
  return [...variantes];
}

/**
 * Décode et assainit le chemin demandé.
 * @returns {string|null} chemin relatif sûr, ou null si suspect
 */
function cheminRelatifSur(cheminBrut) {
  let decode;
  try {
    decode = decodeURIComponent(cheminBrut);
  } catch {
    return null; // séquence %XX invalide
  }

  // Octet NUL : tronquerait le chemin côté système de fichiers.
  if (decode.includes('\0')) return null;

  const relatif = decode.replace(/^\/+/, '');
  if (!relatif) return null;

  // Remontée de répertoire — express.static s'en protège aussi, mais on ne
  // veut pas non plus qu'un `..` fausse la résolution du propriétaire.
  const segments = relatif.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;

  return relatif;
}

// ── Résolution du propriétaire ──────────────────────────────────────────────

/** Organisation propriétaire d'un chantier. */
async function organisationDuChantier(chantierId) {
  if (!chantierId) return null;
  const chantier = await Chantier.findByPk(chantierId, {
    attributes: ['id', 'organisationId'],
    paranoid: false,
  });
  return chantier ? chantier.organisationId : null;
}

/** Organisation propriétaire d'une réserve (via son chantier). */
async function organisationDeLaReserve(reserveId) {
  if (!reserveId) return null;
  const reserve = await Reserve.findByPk(reserveId, {
    attributes: ['id', 'chantierId'],
    paranoid: false,
  });
  return reserve ? organisationDuChantier(reserve.chantierId) : null;
}

/** Organisation propriétaire d'une inspection (via son chantier). */
async function organisationDeLInspection(inspectionId) {
  if (!inspectionId) return null;
  const inspection = await Inspection.findByPk(inspectionId, {
    attributes: ['id', 'chantierId'],
    paranoid: false,
  });
  return inspection ? organisationDuChantier(inspection.chantierId) : null;
}

/**
 * Retrouve la ressource propriétaire d'un fichier.
 * @returns {Promise<{ressource: string, id: string, organisationId: string}|null>}
 */
async function resoudreProprietaire(sousDossier, urls) {
  const where = { [Op.in]: urls };

  // ── Plans (/uploads/plans/…) → Plan.fichier_url → chantier → organisation
  if (sousDossier === 'plans') {
    const plan = await Plan.findOne({
      where: { fichier_url: where }, attributes: ['id', 'chantierId'], paranoid: false,
    });
    if (!plan) return null;
    return { ressource: 'Plan', id: plan.id, organisationId: await organisationDuChantier(plan.chantierId) };
  }

  // ── Documents GED (/uploads/documents/…) → Document.fichier_url
  if (sousDossier === 'documents') {
    const doc = await Document.findOne({
      where: { fichier_url: where }, attributes: ['id', 'chantierId'], paranoid: false,
    });
    if (!doc) return null;
    return { ressource: 'Document', id: doc.id, organisationId: await organisationDuChantier(doc.chantierId) };
  }

  // ── Rapports PDF générés (/uploads/rapports/…) → Rapport.fichier_url
  if (sousDossier === 'rapports') {
    const rapport = await Rapport.findOne({
      where: { fichier_url: where }, attributes: ['id', 'chantierId'], paranoid: false,
    });
    if (!rapport) return null;
    return { ressource: 'Rapport', id: rapport.id, organisationId: await organisationDuChantier(rapport.chantierId) };
  }

  // ── Médias (/uploads/medias/photos|videos|audios/…) → Media.url
  // Le test est un `startsWith` : `media.service.js` produit aujourd'hui un
  // sous-dossier corrompu pour les vidéos (échappement `\v` — voir rapport),
  // le premier segment n'est donc pas toujours exactement 'medias'.
  if (sousDossier.startsWith('medias')) {
    const media = await Media.findOne({
      where: { url: where }, attributes: ['id', 'reserveId', 'inspectionId'],
    });
    if (!media) return null;
    const organisationId = media.reserveId
      ? await organisationDeLaReserve(media.reserveId)
      : await organisationDeLInspection(media.inspectionId);
    return { ressource: 'Media', id: media.id, organisationId };
  }

  // ── Pièces jointes de réserve (/uploads/reserves/pieces/…) → PieceJointe.fichier_url
  if (sousDossier === 'reserves' || sousDossier === 'pieces') {
    const piece = await PieceJointe.findOne({
      where: { fichier_url: where }, attributes: ['id', 'reserveId'], paranoid: false,
    });
    if (!piece) return null;
    return { ressource: 'PieceJointe', id: piece.id, organisationId: await organisationDeLaReserve(piece.reserveId) };
  }

  // ── Photos de profil (/uploads/profils/…) → Utilisateur.photoProfil
  // Décision : visibles par les membres de la même organisation (avatars).
  if (sousDossier === 'profils') {
    const utilisateur = await Utilisateur.findOne({
      where: { photoProfil: where }, attributes: ['id', 'organisationId'], paranoid: false,
    });
    if (!utilisateur) return null;
    return { ressource: 'PhotoProfil', id: utilisateur.id, organisationId: utilisateur.organisationId };
  }

  // ── Logos d'organisation (/uploads/organisations/…) → Organisation.logo_url
  if (sousDossier === 'organisations') {
    const organisation = await Organisation.findOne({
      where: { logo_url: where }, attributes: ['id'], paranoid: false,
    });
    if (!organisation) return null;
    return { ressource: 'LogoOrganisation', id: organisation.id, organisationId: organisation.id };
  }

  // Sous-dossier hors liste blanche → aucun propriétaire possible.
  return null;
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * À monter ENTRE `checkActiveUser` et `express.static` sur /uploads.
 * Suppose `req.user` déjà renseigné par `auth.middleware.js`.
 */
const checkFileAccess = async (req, res, next) => {
  try {
    // express.static ne répond qu'aux lectures ; les autres méthodes tombent
    // dans le 404 global — inutile d'interroger la base pour elles.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const user = req.user;
    if (!user) return next(new ForbiddenError('Utilisateur non authentifié'));

    const relatif = cheminRelatifSur(req.path);
    if (!relatif) {
      logger.warn(`[uploads] Chemin refusé (malformé) : ${req.originalUrl} — user=${user.id}`);
      return next(new BadRequestError('Chemin de fichier invalide'));
    }

    const sousDossier = relatif.split('/')[0];
    const urls = variantesUrl(relatif);
    const cleCache = urls[0];

    let proprietaire = lireCache(cleCache);
    if (proprietaire === undefined) {
      proprietaire = await resoudreProprietaire(sousDossier, urls);
      ecrireCache(cleCache, proprietaire);
    }

    // Orphelin / sous-dossier inconnu → refus par défaut.
    // 404 (et non 403) : ne pas confirmer l'existence d'un fichier à un tiers.
    if (!proprietaire) {
      logger.warn(
        `[uploads] REFUS (fichier orphelin ou inconnu) — user=${user.id} <${user.email}> `
        + `org=${user.organisationId} chemin=${relatif}`
      );
      return next(new NotFoundError('Fichier introuvable'));
    }

    const memeOrganisation = proprietaire.organisationId
      && user.organisationId
      && String(proprietaire.organisationId) === String(user.organisationId);

    if (user.role !== 'Admin' && !memeOrganisation) {
      logger.warn(
        `[uploads] REFUS (organisation étrangère) — user=${user.id} <${user.email}> `
        + `org=${user.organisationId} → ${proprietaire.ressource}#${proprietaire.id} `
        + `org_proprietaire=${proprietaire.organisationId} chemin=${relatif}`
      );
      return next(new ForbiddenError("Accès refusé : ce fichier appartient à une autre organisation."));
    }

    // Journalisation des accès accordés (exigence du cahier des charges).
    logger.info(
      `[uploads] ACCES — user=${user.id} <${user.email}> role=${user.role} `
      + `org=${user.organisationId} → ${proprietaire.ressource}#${proprietaire.id} chemin=${relatif}`
    );

    // Les fichiers servis ne doivent jamais être interprétés par le navigateur
    // ni mis en cache par un intermédiaire partagé (contenu privé par nature).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = checkFileAccess;
module.exports._interne = { cheminRelatifSur, variantesUrl, cache };
