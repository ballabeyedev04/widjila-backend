'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  Reserve, Chantier, PieceJointe, ReserveAffectation, Utilisateur, Organisation,
  Partenaire, Signature, ReserveHistorique,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const ReserveService = require('./reserve.service.js');

/**
 * Réserves — extensions module 5 : pièces jointes, affectations multiples,
 * signatures et QR code de traçabilité.
 */
/**
 * Les TROIS destinataires possibles d'une affectation, joints.
 *
 * Écrit une fois : la création et la lecture rendent ainsi exactement la même
 * forme, et l'une ne peut pas se mettre à renvoyer un nom que l'autre omet.
 *
 * `required: false` partout — une affectation ne porte qu'UN destinataire, les
 * deux autres jointures sont vides par construction. En `required: true`, la
 * ligne ne remonterait jamais.
 */
const AFFECTATION_DESTINATAIRES = [
  { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'photoProfil'], required: false },
  { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'], required: false },
  { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
];

class ReserveExtraService {

  // -------------------- PIÈCES JOINTES --------------------
  static async _verifierReserve(organisationId, reserveId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    return reserve && reserve.chantier ? reserve : null;
  }

  static async ajouterPieceJointe(organisationId, reserveId, fichier, uploaderId) {
    if (!fichier || !fichier.buffer) return { success: false, message: 'Fichier manquant' };
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const url = await storeFile(fichier.buffer, fichier.originalname, 'reserves/pieces');
    let piece;
    try {
      piece = await PieceJointe.create({
        reserveId,
        nom_fichier: fichier.originalname,
        fichier_url: url,
        mime_type: fichier.mimetype || null,
        taille: fichier.size || null,
        uploaderId,
        checksum: crypto.createHash('sha256').update(fichier.buffer).digest('hex'),
      });
    } catch (err) {
      // Fichier déjà écrit mais ligne non créée → orphelin (audit § 5)
      await deleteFile(url).catch(() => {});
      throw err;
    }

    return { success: true, message: 'Pièce jointe ajoutée', piece };
  }

  static async listPiecesJointes(organisationId, reserveId) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const pieces = await PieceJointe.findAll({ where: { reserveId }, order: [['createdAt', 'DESC']] });
    return { success: true, pieces };
  }

  /**
   * DÉCISION (audit § 5) — PieceJointe est paranoid :
   *   - suppression normale = soft delete → le FICHIER EST CONSERVÉ, la pièce
   *     restant restaurable (une preuve de correction restaurée doit rester
   *     consultable) ;
   *   - purge (`definitif = true`) → la ligne disparaît définitivement, donc le
   *     fichier aussi (best-effort, jamais bloquant).
   */
  static async supprimerPieceJointe(organisationId, pieceId, definitif = false) {
    const piece = await PieceJointe.findByPk(pieceId, {
      include: [{ model: Reserve, as: 'reserve', include: [{ model: Chantier, as: 'chantier', where: { organisationId } }] }],
      paranoid: !definitif,
    });
    if (!piece || !piece.reserve || !piece.reserve.chantier) {
      return { success: false, message: 'Pièce jointe introuvable dans cette organisation' };
    }

    const urlFichier = piece.fichier_url;
    await piece.destroy({ force: definitif });

    if (definitif) {
      await deleteFile(urlFichier).catch((err) =>
        logger.warn(`[reserve] Pièce jointe non supprimée du disque : ${err.message}`)
      );
    }

    return {
      success: true,
      message: definitif ? 'Pièce jointe supprimée définitivement' : 'Pièce jointe supprimée',
    };
  }

  // -------------------- SIGNATURES (électroniques) --------------------
  static async signer(organisationId, reserveId, { donnees, type = 'signature' }, utilisateurId) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    // Signature + trace d'historique atomiques (audit § 2 / § 3) : une
    // signature électronique sans trace de qui l'a apposée et quand n'a aucune
    // valeur probante.
    const t = await sequelize.transaction();
    let signature;
    try {
      signature = await Signature.create({
        cibleType: 'reserve',
        cibleId: reserveId,
        utilisateurId,
        type,
        donnees: donnees || null,
      }, { transaction: t });

      await ReserveHistorique.create({
        reserveId,
        utilisateurId,
        action: 'signature',
        nouvelles_valeurs: { signatureId: signature.id, type },
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Réserve signée', signature };
  }

  static async listSignatures(organisationId, reserveId) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const signatures = await Signature.findAll({
      where: { cibleType: 'reserve', cibleId: reserveId },
      include: [{ model: Utilisateur, as: 'signataire', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }],
      order: [['signe_le', 'DESC']],
    });
    return { success: true, signatures };
  }

  // -------------------- AFFECTATIONS MULTIPLES --------------------
  /**
   * @param {string|null} acteurId — auteur de l'affectation (pour l'historique).
   *        Paramètre optionnel ajouté en fin de signature pour ne casser aucun
   *        appelant existant ; le contrôleur doit lui passer `req.user.id`.
   */
  static async affecter(
    organisationId,
    reserveId,
    { utilisateurId, entrepriseId, partenaireId },
    dateAffectation = null,
    acteurId = null,
  ) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    if (utilisateurId) {
      const u = await Utilisateur.findOne({ where: { id: utilisateurId, organisationId } });
      if (!u) return { success: false, message: 'Utilisateur non rattaché à votre organisation' };
    }
    // CORRECTIF (audit § 8) — `Organisation.findByPk` ne contrôlait QUE
    // l'existence : n'importe quel UUID d'organisation de la plateforme était
    // accepté, y compris une entreprise concurrente d'un autre tenant, qui se
    // retrouvait affectée à une réserve qu'elle ne voit pas. On applique la
    // même règle de rattachement que ReserveService (org, filiale ou agence).
    if (entrepriseId) {
      const erreur = await ReserveService._verifierEntreprise(organisationId, entrepriseId);
      if (erreur) return { success: false, message: erreur };
    }
    // L'ANNUAIRE du chantier — le destinataire le plus fréquent. Contrôlé par
    // la même règle que `reserves.partenaireId` : la fiche doit appartenir à
    // l'annuaire de CETTE organisation, sinon un identifiant deviné désignerait
    // l'entreprise d'un autre client.
    if (partenaireId) {
      const erreur = await ReserveService._verifierPartenaire(organisationId, partenaireId);
      if (erreur) return { success: false, message: erreur };
    }

    // CORRECTIF (audit § 3 / § 8) — une affectation est une modification de la
    // réserve : la règle « toute modification est historisée » l'impose, et
    // c'est la seule trace de qui a désigné l'intervenant. Écriture atomique
    // avec l'affectation.
    const t = await sequelize.transaction();
    let affectation;
    try {
      affectation = await ReserveAffectation.create({
        reserveId,
        utilisateurId: utilisateurId || null,
        entrepriseId: entrepriseId || null,
        partenaireId: partenaireId || null,
        date_affectation: dateAffectation ? new Date(dateAffectation) : new Date(),
      }, { transaction: t });

      await ReserveHistorique.create({
        reserveId,
        utilisateurId: acteurId,
        action: 'affectation',
        nouvelles_valeurs: {
          affectationId: affectation.id,
          utilisateurId: utilisateurId || null,
          entrepriseId: entrepriseId || null,
          partenaireId: partenaireId || null,
        },
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    // Rechargée AVEC ses associations avant de répondre.
    //
    // `create` rend la ligne BRUTE : trois clés étrangères, aucun nom. Le
    // client l'insérait telle quelle en tête de sa liste et affichait « — » à
    // la place du destinataire, jusqu'au prochain rechargement complet — juste
    // après le geste où l'on veut précisément vérifier qu'on a désigné la
    // bonne personne.
    //
    // Le POST rend donc désormais exactement la même forme que le GET : le
    // client n'a qu'un seul format à savoir lire.
    const complete = await ReserveAffectation.findByPk(affectation.id, {
      include: AFFECTATION_DESTINATAIRES,
    });

    return {
      success: true,
      message: 'Intervenant affecté à la réserve',
      affectation: complete || affectation,
    };
  }

  static async listAffectations(organisationId, reserveId) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const affectations = await ReserveAffectation.findAll({
      where: { reserveId },
      include: AFFECTATION_DESTINATAIRES,
      order: [['date_affectation', 'DESC']],
    });
    return { success: true, affectations };
  }

  static async retirerAffectation(organisationId, reserveId, affectationId, acteurId = null) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const affectation = await ReserveAffectation.findOne({ where: { id: affectationId, reserveId } });
    if (!affectation) return { success: false, message: 'Affectation introuvable' };

    // Retrait d'intervenant = modification de la réserve → historisé (audit § 3)
    const t = await sequelize.transaction();
    try {
      await ReserveHistorique.create({
        reserveId,
        utilisateurId: acteurId,
        action: 'desaffectation',
        anciennes_valeurs: {
          affectationId: affectation.id,
          partenaireId: affectation.partenaireId || null,
          utilisateurId: affectation.utilisateurId || null,
          entrepriseId: affectation.entrepriseId || null,
        },
      }, { transaction: t });

      await affectation.destroy({ transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Affectation retirée' };
  }

  // -------------------- QR CODE --------------------
  /**
   * Génère un QR code pointant vers la réserve (tracabilité sur chantier).
   * L'URL cible le frontend (FRONTEND_URL) — paramètre reserva=<id>.
   */
  static async genererQr(organisationId, reserveId) {
    const reserve = await ReserveExtraService._verifierReserve(organisationId, reserveId);
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const url = `${base}/reserves/${reserve.id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 });

    return { success: true, qr: dataUrl, url };
  }
}

module.exports = ReserveExtraService;
