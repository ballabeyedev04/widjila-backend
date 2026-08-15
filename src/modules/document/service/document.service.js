'use strict';

const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { Document, Chantier, Signature, Utilisateur } = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const escapeLike = require('../../../utils/escapeLike.js');

// ══════════════════════════════════════════════════════════════════════════════
//  VERSIONNEMENT DES DOCUMENTS (audit § 6) — même défaut que les plans.
//
//  `findOne(order: version DESC)` puis `version + 1`, sans transaction ni
//  contrainte unique :
//    1. deux téléversements simultanés du même nom de fichier produisaient deux
//       « version 3 » sans qu'aucune erreur ne soit levée ;
//    2. Document étant paranoid, supprimer la dernière version faisait
//       réutiliser son numéro — deux contenus distincts pour une même
//       référence contractuelle (DOE, PV…), ce qu'aucune GED ne peut admettre.
//
//  Correction : verrou consultatif Postgres dans la transaction + MAX calculé
//  avec `paranoid: false` (mêmes lignes que l'index unique) + index unique
//  `documents_chantier_nom_version_unique` posé par migration + réessai.
// ══════════════════════════════════════════════════════════════════════════════

/** Sérialise le calcul de version pour un couple (chantier, nom de fichier). */
async function _verrouillerVersion(chantierId, nomFichier, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle)) AS verrou', {
    replacements: { cle: `document:version:${chantierId}:${nomFichier}` },
    type: QueryTypes.SELECT,
    transaction,
  });
}

function _estCollisionVersion(err) {
  if (!(err instanceof UniqueConstraintError)) return false;
  const contrainte = (err.parent && err.parent.constraint) || '';
  const champs = Object.keys(err.fields || {}).join(',');
  return `${contrainte} ${champs}`.includes('version');
}

async function _avecReessaiVersion(operation, tentatives = 3) {
  for (let essai = 1; ; essai += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!_estCollisionVersion(err) || essai >= tentatives) throw err;
      logger.warn(`[document] Collision de version détectée — réessai ${essai}/${tentatives - 1}`);
    }
  }
}

class DocumentService {

  // -------------------- UPLOAD D'UN DOCUMENT --------------------
  /**
   * Enregistre un document (DOE, contrat, PV, compte rendu, rapport…)
   * avec versionning : le même type + nom de fichier incrémente la version.
   */
  static async upload(organisationId, chantierId, data, fichier, uploaderId) {
    if (!fichier || !fichier.buffer) {
      return { success: false, message: 'Fichier document manquant' };
    }

    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Écriture disque avant la transaction ; fichier orphelin nettoyé si la
    // base refuse l'enregistrement (audit § 5).
    const fichier_url = await storeFile(fichier.buffer, fichier.originalname, 'documents');

    try {
      const document = await _avecReessaiVersion(async () => {
        const t = await sequelize.transaction();
        try {
          await _verrouillerVersion(chantierId, fichier.originalname, t);

          const max = await Document.max('version', {
            where: { chantierId, nom_fichier: fichier.originalname },
            paranoid: false, // l'index unique compte aussi les versions supprimées
            transaction: t,
          });
          const version = (Number(max) || 0) + 1;

          const cree = await Document.create({
            chantierId,
            type: data.type || 'autre',
            nom_fichier: fichier.originalname,
            fichier_url,
            mime_type: fichier.mimetype || null,
            taille: fichier.size || null,
            version,
            uploaderId: uploaderId || null,
          }, { transaction: t });

          await t.commit();
          return cree;
        } catch (err) {
          await t.rollback();
          throw err;
        }
      });

      return { success: true, message: 'Document téléversé avec succès', document };
    } catch (err) {
      await deleteFile(fichier_url).catch(() => {});
      throw err;
    }
  }

  // -------------------- LISTER LES DOCUMENTS D'UN CHANTIER --------------------
  /**
   * Recherche plein-texte (module 7) : filtre par type, statut (actif/archive)
   * et mot-clé sur le nom de fichier / type (insensible à la casse).
   */
  static async listDocuments(organisationId, chantierId, { type, statut, search } = {}) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const where = { chantierId };
    if (type) where.type = type;
    if (statut) where.statut = statut;
    if (search && String(search).trim()) {
      const q = `%${escapeLike(String(search).trim())}%`;
      where[Op.or] = [
        { nom_fichier: { [Op.iLike]: q } },
        { type: { [Op.iLike]: q } },
      ];
    }

    const documents = await Document.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });
    return { success: true, documents };
  }

  // -------------------- ARCHIVAGE (module 7) --------------------
  static async archiverDocument(organisationId, documentId, archive = true) {
    const document = await Document.findByPk(documentId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!document) return { success: false, message: 'Document introuvable dans cette organisation' };

    await document.update({ statut: archive ? 'archive' : 'actif' });
    return {
      success: true,
      message: archive ? 'Document archivé' : 'Document restauré',
      document,
    };
  }

  // -------------------- SIGNATURE (module 7) --------------------
  /**
   * Signe un document : crée une entrée Signature (polymorphe, cibleType
   * 'document') et reporte signataireId / signe_le sur le document.
   */
  static async signerDocument(organisationId, documentId, { donnees = null }, utilisateurId) {
    const document = await Document.findByPk(documentId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!document) return { success: false, message: 'Document introuvable dans cette organisation' };

    // CORRECTIF (audit § 2) — atomicité. `Signature.create` puis
    // `document.update` étaient deux écritures indépendantes : si la seconde
    // échouait, le document affichait « non signé » alors qu'une signature
    // électronique valide existait en base (et inversement au niveau du
    // rapport PDF, qui lit signataireId). Un document contractuel ne peut pas
    // se contredire lui-même.
    const t = await sequelize.transaction();
    let signature;
    try {
      signature = await Signature.create({
        cibleType: 'document',
        cibleId: documentId,
        utilisateurId,
        type: 'signature',
        donnees: donnees || null,
      }, { transaction: t });

      await document.update(
        { signataireId: utilisateurId, signe_le: new Date() },
        { transaction: t }
      );

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Document signé', signature };
  }

  static async listSignatures(organisationId, documentId) {
    const document = await Document.findByPk(documentId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!document) return { success: false, message: 'Document introuvable dans cette organisation' };

    const signatures = await Signature.findAll({
      where: { cibleType: 'document', cibleId: documentId },
      include: [{ model: Utilisateur, as: 'signataire', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }],
      order: [['signe_le', 'DESC']],
    });
    return { success: true, signatures };
  }

  // -------------------- SUPPRIMER UN DOCUMENT --------------------
  /**
   * DÉCISION (audit § 5) — fichier sur disque vs soft delete :
   *   - suppression NORMALE : soft delete, le document reste restaurable donc
   *     LE FICHIER EST CONSERVÉ (un `restore()` doit rendre un document
   *     téléchargeable, pas une ligne pointant vers le vide). Le fichier n'est
   *     plus atteignable par l'API : toute lecture passe par une ligne active.
   *   - PURGE (`definitif = true`) : la ligne quitte la base pour de bon, plus
   *     aucune référence ne subsiste → le fichier est effacé du disque en
   *     best-effort (deleteFile ne doit jamais faire échouer l'action métier).
   * Les signatures suivent le document en cas de purge : conserver la preuve
   * d'une signature d'un document introuvable n'a aucune valeur juridique.
   */
  static async supprimerDocument(organisationId, documentId, definitif = false) {
    const document = await Document.findByPk(documentId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      paranoid: !definitif, // une purge peut viser un document déjà soft-deleted
    });
    if (!document) return { success: false, message: 'Document introuvable dans cette organisation' };

    const urlFichier = document.fichier_url;

    const t = await sequelize.transaction();
    try {
      if (definitif) {
        await Signature.destroy({
          where: { cibleType: 'document', cibleId: documentId },
          transaction: t,
        });
      }
      await document.destroy({ force: definitif, transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    if (definitif) {
      await deleteFile(urlFichier).catch((err) =>
        logger.warn(`[document] Fichier non supprimé du disque : ${err.message}`)
      );
    }

    return {
      success: true,
      message: definitif ? 'Document supprimé définitivement' : 'Document supprimé',
    };
  }
}

module.exports = DocumentService;
