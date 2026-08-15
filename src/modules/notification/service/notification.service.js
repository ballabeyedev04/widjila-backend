'use strict';

const { Notification, Utilisateur, DeviceToken, Chantier, ChantierMembre } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');

/**
 * Notification in-app — utilisée par les services métier pour informer
 * les intervenants (nouvelle réserve, changement de statut, échéance…).
 *
 * Push FCM : non activé dans cette version (firebase-admin non installé).
 * Pour l'activer : installer firebase-admin et définir FIREBASE_SERVICE_ACCOUNT_JSON.
 */
class NotificationService {

  /**
   * Crée une notification in-app pour un utilisateur (best-effort).
   * @param {{ utilisateurId, type, titre, message, donnees }} params
   */
  static async notifier({ utilisateurId, type, titre, message = null, donnees = null }) {
    if (!utilisateurId) return;
    try {
      await Notification.create({ utilisateurId, type, titre, message, donnees });
    } catch (err) {
      logger.warn(`[notification] Échec création notif ${type} pour ${utilisateurId} :`, err.message);
    }
  }

  /**
   * Broadcast (module 8) — notifie tous les membres d'une organisation.
   *
   * Correctif (audit — Performance §2 / N+1 §6) : la version précédente
   * faisait un `INSERT` séquentiel par membre (`for…of` + `await` un par
   * un) — une organisation de 500 personnes déclenchait 500 allers-retours
   * DB pour un seul appel. `bulkCreate` regroupe tout en une requête.
   *
   * @param {{ type, titre, message, donnees }} payload
   */
  static async broadcastOrganisation(organisationId, payload) {
    const membres = await Utilisateur.findAll({ where: { organisationId }, attributes: ['id'] });
    if (membres.length === 0) return { success: true, total: 0 };

    await Notification.bulkCreate(
      membres.map((m) => ({
        utilisateurId: m.id,
        type: payload.type,
        titre: payload.titre,
        message: payload.message ?? null,
        donnees: payload.donnees ?? null,
      })),
      { validate: true } // parité avec Notification.create() : bulkCreate ne valide pas par défaut
    );
    return { success: true, total: membres.length };
  }

  /**
   * Broadcast (module 8) — notifie tous les membres affectés à un chantier
   * (via la table ChantierMembre). Le chantier doit appartenir à l'organisation.
   * Même correctif `bulkCreate` que `broadcastOrganisation` ci-dessus.
   */
  static async broadcastChantier(organisationId, chantierId, payload) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable dans cette organisation' };

    const membres = await ChantierMembre.findAll({ where: { chantierId }, attributes: ['utilisateurId'] });
    const idsUniques = [...new Set(membres.map((m) => m.utilisateurId))];
    if (idsUniques.length === 0) return { success: true, total: 0 };

    await Notification.bulkCreate(
      idsUniques.map((utilisateurId) => ({
        utilisateurId,
        type: payload.type,
        titre: payload.titre,
        message: payload.message ?? null,
        donnees: payload.donnees ?? null,
      })),
      { validate: true }
    );
    return { success: true, total: idsUniques.length };
  }

  /**
   * Détecte si une notification métier identique a déjà été émise
   * (anti-doublon pour les rappels / escalades). La colonne donnees étant
   * de type JSON, la comparaison se fait sur égalité exacte de l'objet —
   * les appelants doivent donc passer le même objet donnees à chaque relance.
   */
  static async dejaNotifie(utilisateurId, type, donnees = null) {
    const where = { utilisateurId, type };
    if (donnees) where.donnees = donnees;
    const found = await Notification.findOne({ where });
    return Boolean(found);
  }

  // -------------------- LISTER LES NOTIFICATIONS --------------------
  static async listNotifications(utilisateurId, { page = 1, limit = 20, nonLues = false } = {}) {
    const where = { utilisateurId };
    if (nonLues) where.lu_a = null;

    const { rows, count } = await Notification.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    const nonLuesCount = await Notification.count({ where: { utilisateurId, lu_a: null } });

    return { success: true, notifications: rows, total: count, nonLuesCount };
  }

  // -------------------- MARQUER COMME LUE --------------------
  /** @param {string} userId — les ids fournis ou toutes si non précisés */
  static async marquerLues(userId, ids = []) {
    const where = { utilisateurId: userId };
    if (ids.length) where.id = ids;
    await Notification.update({ lu_a: new Date() }, { where });
    return { success: true, message: 'Notifications marquées comme lues' };
  }

  // -------------------- SAUVEGARDER UN TOKEN DE DEVICE --------------------
  /** Préparation pour le push futur — persiste le token par utilisateur. */
  static async saveDeviceToken(utilisateurId, token, platform = 'web') {
    await DeviceToken.upsert(
      { utilisateurId, token, platform },
      { conflictFields: ['token'] }
    );
    return { success: true };
  }

  // -------------------- ENVOYER UN PUSH (préparé, désactivé sans firebase-admin) --------------------
  static async sendPush(utilisateurIds, payload) {
    // Voir commentaire en tête de fichier — FCM non activé dans cette version.
    logger.info(`[push] (désactivé) notification différée vers ${utilisateurIds} : ${payload.title}`);
  }
}

module.exports = NotificationService;
