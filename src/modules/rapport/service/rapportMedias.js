'use strict';

const { ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const { detectType } = require('../../../middlewares/upload.middleware.js');
const logger = require('../../../utils/logger.js');

/**
 * Lecture des PHOTOS et des PLANS qui alimentent un rapport.
 *
 * ── Deux règles tenues d'un bout à l'autre ─────────────────────────────────
 *
 * 1. RIEN NE BLOQUE LE RAPPORT. Une photo illisible, un plan absent du
 *    stockage, un objet trop lourd : chacun de ces cas fait perdre UNE
 *    illustration, jamais le document. Un rapport amputé d'une vignette reste
 *    utile ; un rapport qui n'existe pas fait perdre la visite.
 *
 * 2. LES VOLUMES SONT BORNÉS. Un chantier porte des centaines de réserves et
 *    des milliers de photos. Tout charger en mémoire pour un seul PDF ferait
 *    tomber le processus — et le rapport DIT ce qu'il contient (§ « Périmètre »
 *    du document), pour que l'absence soit visible plutôt que subie.
 */

/** Plafonds de lecture — voir la règle 2 ci-dessus. */
const TAILLE_PHOTO_MAX = 4 * 1024 * 1024;   // 4 Mo par photo
const TAILLE_PLAN_MAX = 40 * 1024 * 1024;   // 40 Mo par plan (un PDF A0 est lourd)
const PHOTOS_TOTAL_MAX = 120;
const PLANS_MAX = 30;

/** Formats d'image que pdfkit sait dessiner. Le reste sera annoncé, pas deviné. */
const IMAGES_SUPPORTEES = new Set(['png', 'jpg']);

/** Lit un flux en mémoire, en coupant net au-delà de `tailleMax`. */
function lireFlux(flux, tailleMax) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let total = 0;
    flux.on('data', (bloc) => {
      total += bloc.length;
      // Un fichier anormalement gros est presque toujours une erreur d'import.
      // On abandonne cette pièce-là, pas le rapport.
      if (total > tailleMax) {
        flux.destroy();
        resolve(null);
        return;
      }
      morceaux.push(bloc);
    });
    flux.on('end', () => resolve(Buffer.concat(morceaux)));
    flux.on('error', reject);
  });
}

/**
 * Charge un fichier du stockage en mémoire.
 * @returns {Promise<Buffer|null>} `null` si absent, trop lourd ou illisible.
 */
async function chargerBuffer(reference, tailleMax) {
  if (!reference) return null;
  try {
    const fichier = await ouvrirFichier(reference);
    if (!fichier || !fichier.stream) return null;
    const buffer = await lireFlux(fichier.stream, tailleMax);
    return buffer && buffer.length ? buffer : null;
  } catch (err) {
    logger.warn(`[rapport] Fichier ignoré (${reference}) : ${err.message}`);
    return null;
  }
}

/** Date de prise de vue d'un média — `pris_le` prime sur la date d'import. */
function dateMedia(media) {
  const brut = media.pris_le || media.createdAt;
  const date = brut ? new Date(brut) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Range les photos d'une réserve AVANT et APRÈS la correction (§ 17).
 *
 * ── Pourquoi c'est CALCULÉ et non lu dans une colonne ──────────────────────
 *
 * Aucune photo ne porte de marqueur « avant / après » : personne ne le
 * renseigne au moment de la prise de vue, sur un chantier. Ce qui est connu,
 * en revanche, c'est la DATE de chaque cliché et la date à laquelle
 * l'entreprise a déclaré la correction faite (`dateCorrection`, tirée de
 * l'historique de la réserve).
 *
 * Une photo prise avant cette date montre le défaut ; une photo prise après
 * montre la correction. C'est exactement le raisonnement que ferait un
 * conducteur de travaux en regardant l'horodatage.
 *
 * Sans date de correction connue, on ne tranche PAS : toutes les photos
 * restent en « avant » et le rapport écrit « Non renseigné » pour l'après —
 * plutôt que de présenter comme preuve de correction un cliché du défaut.
 */
function repartirPhotos(medias, dateCorrection) {
  const photos = (medias || [])
    .filter((m) => m.type === 'photo' && m.url)
    .map((m) => ({ media: m, date: dateMedia(m) }))
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;   // les clichés sans date passent en dernier
      if (!b.date) return -1;
      return a.date - b.date;
    });

  if (!dateCorrection) return { avant: photos.map((p) => p.media), apres: [] };

  const limite = new Date(dateCorrection).getTime();
  const avant = photos.filter((p) => !p.date || p.date.getTime() < limite).map((p) => p.media);
  const apres = photos.filter((p) => p.date && p.date.getTime() >= limite).map((p) => p.media);
  return { avant, apres };
}

/**
 * Charge les photos des réserves, dans les limites fixées.
 *
 * `fiche` décide de ce qu'on va chercher :
 *   - `standard` : jusqu'à `parReserve` clichés, les plus récents d'abord —
 *     ce sont eux qui montrent l'état actuel du défaut ;
 *   - `levee`    : UNE photo avant et UNE photo après, ce que demande le
 *     § 17. Deux photos « avant » ne prouveraient rien de la correction.
 *
 * Chaque réserve reçoit `photosAvant`, `photosApres` et `photos` (ce que la
 * fiche standard affiche), toujours définis — même vides.
 */
async function chargerPhotos(reserves, { parReserve = 2, total = PHOTOS_TOTAL_MAX, fiche = 'standard' } = {}) {
  let restantes = Math.max(0, total);
  let chargees = 0;
  let ignorees = 0;

  /** La vignette d'abord (plus légère), l'original à défaut. */
  const lire = async (media) => {
    const buffer = await chargerBuffer(media.thumbnail_url || media.url, TAILLE_PHOTO_MAX)
      || await chargerBuffer(media.url, TAILLE_PHOTO_MAX);
    if (!buffer) {
      ignorees += 1;
      return null;
    }
    // pdfkit ne sait dessiner que PNG et JPEG. Un WebP passerait la lecture
    // puis ferait lever la mise en page, réserve par réserve.
    const type = detectType(buffer);
    if (!IMAGES_SUPPORTEES.has(type)) {
      ignorees += 1;
      return null;
    }
    return { buffer, date: dateMedia(media), id: media.id };
  };

  for (const reserve of reserves) {
    reserve.photos = [];
    reserve.photosAvant = [];
    reserve.photosApres = [];
    if (restantes <= 0) continue;

    const { avant, apres } = repartirPhotos(reserve.medias, reserve.dateCorrection);

    if (fiche === 'levee') {
      // La dernière photo AVANT (le défaut tel qu'il a été constaté en
      // dernier) et la dernière photo APRÈS (la correction telle qu'elle a
      // été livrée).
      const choix = [avant[avant.length - 1], apres[apres.length - 1]].filter(Boolean);
      for (const [index, media] of choix.entries()) {
        if (restantes <= 0) break;
        const image = await lire(media);
        if (!image) continue;
        restantes -= 1;
        chargees += 1;
        if (index === 0 && avant.length) reserve.photosAvant.push(image);
        else reserve.photosApres.push(image);
      }
      reserve.photos = [...reserve.photosAvant, ...reserve.photosApres];
      continue;
    }

    const toutes = [...avant, ...apres];
    // Les plus RÉCENTES : sur une réserve suivie depuis trois mois, ce sont
    // elles qui montrent l'état d'aujourd'hui.
    const choix = toutes.slice(-Math.min(parReserve, Math.max(0, restantes))).reverse();
    for (const media of choix) {
      const image = await lire(media);
      if (!image) continue;
      restantes -= 1;
      chargees += 1;
      reserve.photos.push(image);
    }
  }

  return { chargees, ignorees };
}

/**
 * Charge les PLANS nécessaires aux pastilles (§ 7).
 *
 * Un plan est chargé UNE FOIS, quel que soit le nombre de réserves qui s'y
 * rapportent : un immeuble entier tient souvent sur trois ou quatre plans, et
 * relire un PDF de 20 Mo par réserve serait absurde.
 *
 * @returns {Promise<Map<string, {id, nom, format, buffer, image, pageCount}>>}
 *   `image` vaut le type détecté (`png`, `jpg`) quand le plan est une image
 *   directement dessinable ; `buffer` est nul quand le plan n'a pas pu être lu
 *   — la fiche affichera alors la position en clair, sans extrait.
 */
async function chargerPlans(reserves, { max = PLANS_MAX } = {}) {
  const plans = new Map();

  for (const reserve of reserves) {
    const plan = reserve.plan;
    if (!plan || !plan.id || plans.has(plan.id)) continue;
    if (plans.size >= max) break;

    const entree = {
      id: plan.id,
      nom: plan.nom,
      format: plan.format,
      pageCount: plan.page_count || null,
      buffer: null,
      image: null,
    };

    // DWG et IFC ne se dessinent pas : aucun aperçu n'est possible sans un
    // convertisseur métier. La fiche le dira, plutôt que d'afficher un cadre
    // vide que le lecteur prendrait pour un défaut d'impression.
    if (plan.fichier_url && plan.format !== 'dwg' && plan.format !== 'ifc') {
      entree.buffer = await chargerBuffer(plan.fichier_url, TAILLE_PLAN_MAX);
      if (entree.buffer) {
        const type = detectType(entree.buffer);
        if (IMAGES_SUPPORTEES.has(type)) entree.image = type;
        else if (type !== 'pdf') entree.buffer = null; // format non dessinable
      }
    }

    plans.set(plan.id, entree);
  }

  return plans;
}

module.exports = {
  chargerBuffer,
  chargerPhotos,
  chargerPlans,
  repartirPhotos,
  dateMedia,
  lireFlux,
  TAILLE_PHOTO_MAX,
  TAILLE_PLAN_MAX,
  PHOTOS_TOTAL_MAX,
  PLANS_MAX,
};
