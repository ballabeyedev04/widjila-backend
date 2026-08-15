'use strict';

const crypto = require('crypto');
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

  // -------------------- ENREGISTREMENT COMMUN --------------------
  static async _enregistrer(reserveId, inspectionId, type, fichier, meta = {}, uploaderId = null) {
    if (!fichier || !fichier.buffer) {
      return { success: false, message: 'Fichier média manquant' };
    }

    const sousDossier = type === 'video' ? 'medias/videos' : type === 'audio' ? 'medias/audios' : 'medias/photos';
    const url = await storeFile(fichier.buffer, fichier.originalname, sousDossier);

    const checksum = crypto.createHash('sha256').update(fichier.buffer).digest('hex');

    let media;
    try {
      media = await Media.create({
        reserveId: reserveId || null,
        inspectionId: inspectionId || null,
        type,
        url,
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
