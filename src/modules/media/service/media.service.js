'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { Media, Reserve, Inspection, Chantier, ReserveAffectation } = require('../../../models/index.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');
const sequelize = require('../../../config/db.js');

/**
 * Suppression de fichier « au mieux » : un nettoyage raté ne doit jamais
 * transformer une réussite en erreur — le fichier en trop se perd, pas
 * l'enregistrement du média. Tolère aussi un `deleteFile` synchrone.
 */
async function _supprimerSansEchec(url) {
  try {
    await deleteFile(url);
  } catch {
    /* fichier orphelin : signalé par le stockage lui-même, sans conséquence ici */
  }
}

/**
 * Média — photos / vidéos / notes vocales des réserves et photos
 * d'inspection. ISOLATION MULTI-TENANT : chaque accès vérifie que la
 * ressource cible (réserve ou inspection) appartient à l'organisation
 * de l'utilisateur connecté (cf. audit sécurité — failles corrigées).
 */
/**
 * Dossier de stockage d'un média — cahier technique § 5.
 *
 * ```
 * photos/projet_{chantierId}/reserves/reserve_{reserveId}/
 * ```
 *
 * ── Pourquoi le chantier dans le chemin ───────────────────────────────────
 *
 * C'est l'unité d'exploitation : on archive un chantier, on restaure un
 * chantier, on exporte les photos d'un chantier. Sans lui, ces trois
 * opérations demandent de lire la base pour savoir quel fichier appartient à
 * quoi — et deviennent impraticables à la main.
 *
 * ── Les cas hors réserve ──────────────────────────────────────────────────
 *
 * Une INSPECTION porte aussi des médias. Elle appartient elle aussi à un
 * chantier : elle est rangée sous le même projet, dans `inspections/` plutôt
 * que `reserves/`. Un média sans parent — cas qui ne devrait pas se produire —
 * retombe sur l'ancien dossier plutôt que d'échouer : perdre un cliché parce
 * qu'on ne sait pas où le classer serait le pire des deux résultats.
 *
 * ── Vidéos et sons ────────────────────────────────────────────────────────
 *
 * Le document ne parle que de `photos/`, mais l'application accepte aussi des
 * vidéos et des mémos vocaux sur une réserve. Ils suivent la même
 * arborescence sous leur propre racine : les ranger ailleurs casserait
 * justement le rangement par chantier que le § 5 demande.
 */
async function _dossierDuMedia(type, reserveId, inspectionId) {
  const racine = type === 'video' ? 'videos' : type === 'audio' ? 'audios' : 'photos';

  if (reserveId) {
    const reserve = await Reserve.findByPk(reserveId, {
      attributes: ['id', 'chantierId'],
      paranoid: false,
    });
    if (reserve) {
      return `${racine}/projet_${reserve.chantierId}/reserves/reserve_${reserveId}`;
    }
  }

  if (inspectionId) {
    const inspection = await Inspection.findByPk(inspectionId, {
      attributes: ['id', 'chantierId'],
      paranoid: false,
    });
    if (inspection) {
      return `${racine}/projet_${inspection.chantierId}/inspections/inspection_${inspectionId}`;
    }
  }

  // Repli : l'ancien dossier à plat. Le contrôle d'accès aux fichiers
  // (`checkFileAccess`) reconnaît les deux formes, les médias déjà en ligne
  // restent donc lisibles sans migration de données.
  return type === 'video' ? 'medias/videos' : type === 'audio' ? 'medias/audios' : 'medias/photos';
}

const TYPES_MEDIA = ['photo', 'video', 'audio'];

// Statuts de réserve après verdict : leurs preuves sont figées.
const STATUTS_RESERVE_FIGES = ['validee', 'cloturee'];

/** Nombre borné, ou null si absent ; `undefined` signale une valeur invalide. */
function _nombre(valeur, min, max) {
  if (valeur === undefined || valeur === null || valeur === '') return null;
  const n = Number(valeur);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/**
 * Métadonnées d'un média, contrôlées.
 *
 * Elles arrivent en multipart, APRÈS multer : aucun schéma Joi ne les voyait.
 * `pris_le` et la géolocalisation servent de PREUVE (photo de correction
 * horodatée et située) — un client pouvait les fixer à n'importe quelle
 * valeur, et une valeur non numérique finissait en erreur 500.
 *
 * @returns {{ ok: true, meta: object } | { ok: false, message: string }}
 */
function _metaMedia(type, meta = {}) {
  if (!TYPES_MEDIA.includes(type)) {
    return { ok: false, message: 'Type de média invalide (photo, video ou audio).' };
  }
  const champs = {
    latitude: _nombre(meta.latitude, -90, 90),
    longitude: _nombre(meta.longitude, -180, 180),
    largeur: _nombre(meta.largeur, 1, 100000),
    hauteur: _nombre(meta.hauteur, 1, 100000),
    duree: _nombre(meta.duree, 0, 24 * 3600),
  };
  const invalide = Object.keys(champs).find((cle) => champs[cle] === undefined);
  if (invalide) return { ok: false, message: `Métadonnée « ${invalide} » invalide.` };

  let prisLe = null;
  if (meta.pris_le !== undefined && meta.pris_le !== null && meta.pris_le !== '') {
    prisLe = new Date(meta.pris_le);
    // Une prise de vue dans le futur n'existe pas (tolérance d'horloge : 10 min).
    if (Number.isNaN(prisLe.getTime()) || prisLe.getTime() > Date.now() + 10 * 60 * 1000) {
      return { ok: false, message: 'Date de prise de vue invalide.' };
    }
  }
  return { ok: true, meta: { ...champs, pris_le: prisLe } };
}

class MediaService {

  /**
   * Le sous-traitant ne dépose des preuves que sur une réserve qui LUI est
   * assignée — même règle que `ReserveService.changerStatut`. Sans elle, il
   * photographiait n'importe quelle réserve de l'organisation, et ce média
   * comptait comme « preuve de correction » exigée pour la validation.
   */
  static async _refusSousTraitant(reserve, utilisateurId, role) {
    if (role !== 'SousTraitant') return null;
    const estAssigne = String(reserve.assigneA) === String(utilisateurId)
      || (await ReserveAffectation.count({ where: { reserveId: reserve.id, utilisateurId } })) > 0;
    return estAssigne ? null : 'Cette réserve ne vous est pas assignée.';
  }

  // -------------------- VÉRIFICATIONS D'APPARTENANCE --------------------
  static async _verifierReserve(organisationId, reserveId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    return reserve && reserve.chantier ? reserve : null;
  }

  static async _verifierInspection(organisationId, inspectionId) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    return inspection && inspection.chantier ? inspection : null;
  }

  /**
   * Vignette d'une photo — `null` si elle ne peut pas être produite.
   *
   * ## Pourquoi elle manquait
   *
   * La colonne `thumbnail_url` existait et TROIS consommateurs la lisaient
   * déjà, chacun avec un repli `thumbnail_url || url`. Comme rien ne
   * l'écrivait jamais, le repli était le seul chemin emprunté :
   *
   *   - la grille de photos d'une réserve téléchargeait l'ORIGINAL — plusieurs
   *     mégaoctets sortis d'un appareil photo de téléphone — pour l'afficher
   *     sur 104 points de large ;
   *   - le générateur de rapports PDF faisait de même, en chargeant chaque
   *     original entier en mémoire serveur (son propre commentaire dit
   *     pourtant « la vignette d'abord : plus légère ») ;
   *   - les aperçus de liste (réserves, plans) idem.
   *
   * ## Choix
   *
   * `rotate()` sans argument applique l'orientation EXIF. Sans lui, les
   * photos prises en portrait ressortent couchées : `sharp` lit les pixels
   * bruts et ignore l'étiquette d'orientation que les visionneuses honorent.
   *
   * `withoutEnlargement` : une image déjà plus petite que 400 px n'est pas
   * agrandie — on produirait un fichier PLUS LOURD que l'original.
   *
   * Un échec ne fait jamais échouer l'envoi : la photo reste enregistrée, et
   * les trois consommateurs retombent sur l'original comme aujourd'hui.
   */
  static async _vignette(buffer, originalname, sousDossier) {
    try {
      const vignette = await sharp(buffer)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();

      // Même sous-dossier que l'original : mêmes règles de visibilité, et la
      // suppression d'un média efface déjà les DEUX URL (voir `supprimer`).
      return await storeFile(vignette, `vignette-${originalname}.jpg`, sousDossier);
    } catch (err) {
      logger.warn(`[media] Vignette non générée (${err.message}) — repli sur l'original`);
      return null;
    }
  }

  // -------------------- ENREGISTREMENT COMMUN --------------------
  static async _enregistrer(reserveId, inspectionId, type, fichier, meta = {}, uploaderId = null) {
    if (!fichier || !fichier.buffer) {
      return { success: false, message: 'Fichier média manquant' };
    }

    const controle = _metaMedia(type, meta);
    if (!controle.ok) return { success: false, message: controle.message };
    meta = controle.meta;

    // ── Rejeu d'un envoi deja abouti ──────────────────────────────────────
    //
    // Le mobile met les photos prises hors ligne dans une file d'attente. Si
    // le serveur ecrit le media puis que la reponse se perd — coupure en
    // pleine reponse, delai depasse sur un reseau de chantier — le client
    // n'a pas d'acquittement : l'action reste en file et repart au prochain
    // passage. Sans garde, la meme photo se retrouvait DEUX FOIS sur la
    // reserve.
    //
    // Le controle porte sur l'empreinte du CONTENU, deja calculee et stockee
    // jusqu'ici sans jamais servir. Deux octets identiques sur la meme
    // reserve, c'est le meme cliche : le second n'apporte rien.
    //
    // Il vient AVANT l'ecriture du fichier, et non apres : un rejeu ne repaye
    // ainsi ni le stockage, ni la generation de vignette — precisement ce
    // qu'on ne veut pas refaire sur une connexion qui vient d'echouer.
    const checksum = crypto.createHash('sha256').update(fichier.buffer).digest('hex');

    const parent = reserveId ? { reserveId } : inspectionId ? { inspectionId } : null;
    if (parent) {
      const dejaPresent = await Media.findOne({ where: { ...parent, checksum } });
      if (dejaPresent) {
        return { success: true, message: 'Média déjà enregistré', media: dejaPresent, rejeu: true };
      }
    }

    // Rangé sous son projet et sa réserve (cahier § 5) plutôt que dans un
    // dossier unique où plus rien ne se retrouve à la main.
    const sousDossier = await _dossierDuMedia(type, reserveId, inspectionId);
    const url = await storeFile(fichier.buffer, fichier.originalname, sousDossier);

    // Uniquement pour les images : `sharp` lèverait sur une vidéo ou un son,
    // et `_vignette` renverrait `null` de toute façon — autant ne pas payer
    // la tentative.
    //
    // La condition porte sur le TYPE, et non plus sur le nom du dossier. Elle
    // comparait `sousDossier === 'medias/photos'`, ce qui a cessé d'être vrai
    // le jour où les fichiers ont été rangés par projet (cahier § 5) :
    // AUCUNE vignette n'aurait plus été produite, et toutes les listes seraient
    // reparties chercher l'original de plusieurs mégaoctets. Le type, lui, ne
    // dépend pas du rangement.
    const thumbnailUrl = type === 'photo'
      ? await MediaService._vignette(fichier.buffer, fichier.originalname, sousDossier)
      : null;

    // ── Deux envois SIMULTANÉS du même contenu (deuxième audit, A2-07) ──────
    //
    // Le contrôle d'empreinte plus haut lit AVANT d'écrire, sans verrou : deux
    // requêtes concurrentes le passaient toutes deux, et la même photo était
    // enregistrée deux fois. Le cas est réel : un envoi en ligne dépasse son
    // délai pendant que le serveur stocke encore le fichier, le mobile met la
    // photo en file, et la file la rejoue quelques centaines de ms plus tard.
    //
    // Verrou consultatif de TRANSACTION sur (parent, empreinte) autour de
    // « revérifier puis créer » — et SEULEMENT autour : l'envoi vers le
    // stockage reste hors verrou, pour ne jamais tenir une connexion de la
    // base pendant le téléversement d'une vidéo. Le perdant d'une course a
    // donc stocké un fichier en trop : il le supprime et renvoie le média du
    // gagnant.
    const cle = parent
      ? `media:${reserveId ? 'reserve' : 'inspection'}:${reserveId || inspectionId}:${checksum}`
      : null;

    let concurrent = null;
    let media;
    try {
      media = await MediaService._sousVerrou(cle, async () => {
        if (parent) {
          concurrent = await Media.findOne({ where: { ...parent, checksum } });
          if (concurrent) return null;
        }
        return Media.create({
          reserveId: reserveId || null,
          inspectionId: inspectionId || null,
          type,
          url,
          thumbnail_url: thumbnailUrl,
          latitude: meta.latitude,
          longitude: meta.longitude,
          largeur: meta.largeur,
          hauteur: meta.hauteur,
          duree: meta.duree,
          checksum,
          uploaderId,
          pris_le: meta.pris_le || new Date(),
        });
      });
    } catch (err) {
      // Le fichier est déjà sur le disque : si la ligne n'a pas pu être créée,
      // il n'aurait plus jamais de référence (audit § 5 — fichier orphelin
      // téléchargeable indéfiniment). Nettoyage best-effort.
      await _supprimerSansEchec(url);
      throw err;
    }

    if (concurrent) {
      // Noms de fichiers uniques (`storage.service.js#storeFile`) : ce sont
      // bien NOS octets en trop qui partent, jamais ceux du gagnant.
      await _supprimerSansEchec(url);
      if (thumbnailUrl) await _supprimerSansEchec(thumbnailUrl);
      return { success: true, message: 'Média déjà enregistré', media: concurrent, rejeu: true };
    }

    return { success: true, message: 'Média ajouté', media };
  }

  /**
   * Exécute [travail] sous le verrou consultatif de TRANSACTION [cle]
   * (`pg_advisory_xact_lock`), rendu à la fin de la transaction — y compris si
   * le processus meurt. Sans clé, [travail] s'exécute tel quel.
   *
   * @template T
   * @param {string|null} cle
   * @param {() => Promise<T>} travail
   * @returns {Promise<T>}
   */
  static async _sousVerrou(cle, travail) {
    if (!cle) return travail();
    return sequelize.transaction(async (t) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle))', { replacements: { cle }, transaction: t });
      return travail();
    });
  }

  // -------------------- AJOUTER UN MÉDIA SUR UNE RÉSERVE --------------------
  static async ajouterMedia(organisationId, reserveId, type, fichier, meta = {}, uploaderId = null, role = null) {
    const reserve = await MediaService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };
    const refus = await MediaService._refusSousTraitant(reserve, uploaderId, role);
    if (refus) return { success: false, message: refus };
    return MediaService._enregistrer(reserveId, null, type, fichier, meta, uploaderId);
  }

  // -------------------- AJOUTER UNE PHOTO SUR UNE INSPECTION --------------------
  static async ajouterPhotoInspection(organisationId, inspectionId, type, fichier, meta = {}, uploaderId = null) {
    const inspection = await MediaService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };
    return MediaService._enregistrer(null, inspectionId, type, fichier, meta, uploaderId);
  }

  // -------------------- LISTER LES MÉDIAS D'UNE RÉSERVE --------------------
  static async listMedias(organisationId, reserveId) {
    const reserve = await MediaService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const medias = await Media.findAll({
      where: { reserveId },
      order: [['createdAt', 'DESC']],
    });
    return { success: true, medias };
  }

  // -------------------- LISTER LES PHOTOS D'UNE INSPECTION --------------------
  static async listPhotosInspection(organisationId, inspectionId) {
    const inspection = await MediaService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const medias = await Media.findAll({
      where: { inspectionId },
      order: [['createdAt', 'DESC']],
    });
    return { success: true, medias };
  }

  // -------------------- SUPPRIMER UN MÉDIA --------------------
  static async supprimerMedia(organisationId, mediaId) {
    const media = await Media.findByPk(mediaId, {
      include: [
        { model: Reserve, as: 'reserve', include: [{ model: Chantier, as: 'chantier', where: { organisationId } }] },
        { model: Inspection, as: 'inspection', include: [{ model: Chantier, as: 'chantier', where: { organisationId } }] },
      ],
    });
    if (!media) return { success: false, message: 'Média introuvable' };

    // Le média doit appartenir à l'org via sa réserve OU son inspection
    const appartient = (media.reserve && media.reserve.chantier) || (media.inspection && media.inspection.chantier);
    if (!appartient) return { success: false, message: 'Média introuvable dans cette organisation' };

    // Une PREUVE ne disparaît pas après le verdict. La validation exige au
    // moins un média (reserve.service#changerStatut) : supprimer ceux d'une
    // réserve validée ou clôturée rompait cet invariant après coup, et
    // effaçait définitivement le fichier — sans trace. Même règle pour le PV
    // d'une inspection signée.
    if (media.reserve && STATUTS_RESERVE_FIGES.includes(media.reserve.statut)) {
      return { success: false, message: 'Ce média est une preuve d’une réserve validée ou clôturée : il ne peut plus être supprimé.' };
    }
    if (media.inspection && media.inspection.statut === 'signee') {
      return { success: false, message: 'Ce média appartient à une inspection signée : il ne peut plus être supprimé.' };
    }

    const fichiers = [media.url, media.thumbnail_url].filter(Boolean);

    await media.destroy(); // suppression définitive (le modèle n'est pas paranoid)

    // CORRECTIF (audit § 5) — `deleteFile()` n'avait AUCUN appelant dans tout
    // src/ : la ligne partait, la photo restait sur le disque et demeurait
    // téléchargeable par quiconque connaissait son URL (les URL /uploads sont
    // servies en statique, sans contrôle d'accès). Media n'étant pas paranoid,
    // cette suppression est DÉFINITIVE : plus aucune ligne ne référencera le
    // fichier, il doit donc disparaître avec elle.
    // Best-effort et APRÈS le destroy : un disque en erreur ne doit jamais
    // faire échouer l'action métier ni laisser croire à un échec.
    for (const url of fichiers) {
      await deleteFile(url).catch((err) =>
        logger.warn(`[media] Fichier non supprimé du disque : ${err.message}`)
      );
    }

    return { success: true, message: 'Média supprimé' };
  }
}

module.exports = MediaService;
