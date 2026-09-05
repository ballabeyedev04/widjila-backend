'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { Media, Reserve, Inspection, Chantier } = require('../../../models/index.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Média — photos / vidéos / notes vocales des réserves et photos
 * d'inspection. ISOLATION MULTI-TENANT : chaque accès vérifie que la
 * ressource cible (réserve ou inspection) appartient à l'organisation
 * de l'utilisateur connecté (cf. audit sécurité — failles corrigées).
 */
class MediaService {

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

    const sousDossier = type === 'video' ? 'medias/videos' : type === 'audio' ? 'medias/audios' : 'medias/photos';
    const url = await storeFile(fichier.buffer, fichier.originalname, sousDossier);

    // Uniquement pour les images : `sharp` lèverait sur une vidéo ou un son,
    // et `_vignette` renverrait `null` de toute façon — autant ne pas payer
    // la tentative.
    const thumbnailUrl = sousDossier === 'medias/photos'
      ? await MediaService._vignette(fichier.buffer, fichier.originalname, sousDossier)
      : null;

    let media;
    try {
      media = await Media.create({
        reserveId: reserveId || null,
        inspectionId: inspectionId || null,
        type,
        url,
        thumbnail_url: thumbnailUrl,
        latitude: meta.latitude || null,
        longitude: meta.longitude || null,
        largeur: meta.largeur || null,
        hauteur: meta.hauteur || null,
        duree: meta.duree || null,
        checksum,
        uploaderId,
        pris_le: meta.pris_le ? new Date(meta.pris_le) : new Date(),
      });
    } catch (err) {
      // Le fichier est déjà sur le disque : si la ligne n'a pas pu être créée,
      // il n'aurait plus jamais de référence (audit § 5 — fichier orphelin
      // téléchargeable indéfiniment). Nettoyage best-effort.
      await deleteFile(url).catch(() => {});
      throw err;
    }

    return { success: true, message: 'Média ajouté', media };
  }

  // -------------------- AJOUTER UN MÉDIA SUR UNE RÉSERVE --------------------
  static async ajouterMedia(organisationId, reserveId, type, fichier, meta = {}, uploaderId = null) {
    const reserve = await MediaService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };
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
