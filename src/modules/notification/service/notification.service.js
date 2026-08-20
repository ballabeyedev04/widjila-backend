'use strict';

const { Notification, Utilisateur, DeviceToken, Chantier, ChantierMembre } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');
const { getMessaging } = require('../../../config/firebase.js');

/**
 * Notification in-app — utilisée par les services métier pour informer
 * les intervenants (nouvelle réserve, changement de statut, échéance…).
 *
 * Deux canaux, toujours dans cet ordre :
 *   1. la notification IN-APP, écrite en base — c'est la source de vérité,
 *      consultable à tout moment depuis l'écran Notifications ;
 *   2. le PUSH FCM, best-effort — il prévient l'utilisateur téléphone
 *      verrouillé. S'il échoue (Firebase non configuré, jeton périmé, panne
 *      réseau), la notification reste en base et l'appelant n'en sait rien.
 *
 * Le push n'est JAMAIS bloquant : une réserve doit pouvoir être affectée
 * même si Google est injoignable.
 *
 * Configuration : voir `config/firebase.js` (FIREBASE_SERVICE_ACCOUNT_JSON).
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
      return; // Rien en base : inutile de pousser une alerte introuvable dans l'app.
    }

    // Volontairement NON attendu : le push ne doit pas retarder l'action
    // métier qui l'a déclenchée (affectation d'une réserve, changement de
    // statut…). Les erreurs sont absorbées par sendPush lui-même.
    NotificationService.sendPush([utilisateurId], { type, titre, message, donnees });
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

    NotificationService.sendPush(membres.map((m) => m.id), payload);
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

    NotificationService.sendPush(idsUniques, payload);
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

  /**
   * Oublie un jeton à la déconnexion. Le filtre porte sur l'utilisateur ET le
   * jeton : sans le premier, n'importe quel compte authentifié pourrait
   * désabonner l'appareil d'un autre en devinant son jeton.
   */
  static async supprimerDeviceToken(utilisateurId, token) {
    if (!token) return { success: true };
    await DeviceToken.destroy({ where: { utilisateurId, token } });
    return { success: true };
  }

  // -------------------- ENVOYER UN PUSH --------------------
  /**
   * Pousse une alerte FCM vers tous les appareils des utilisateurs visés.
   *
   * Best-effort intégral : aucune exception ne remonte à l'appelant. Un push
   * perdu est un désagrément, une action métier annulée parce que Google a
   * eu un hoquet serait une faute.
   *
   * Le message porte un bloc `notification` ET un bloc `data` :
   *   - `notification` est ce qui permet au SYSTÈME d'afficher l'alerte quand
   *     l'application est en arrière-plan ou fermée — sans lui, rien ne
   *     s'affiche téléphone verrouillé ;
   *   - `data` transporte le type et les identifiants métier, pour que
   *     l'ouverture de l'alerte mène au bon écran.
   *
   * @param {string[]} utilisateurIds
   * @param {{ type: string, titre: string, message?: string|null, donnees?: object|null }} payload
   */
  static async sendPush(utilisateurIds, payload) {
    try {
      const messaging = getMessaging();
      if (!messaging) return; // Firebase non configuré — déjà journalisé au démarrage.

      const ids = [...new Set((utilisateurIds || []).filter(Boolean))];
      if (ids.length === 0) return;

      const appareils = await DeviceToken.findAll({
        where: { utilisateurId: ids },
        attributes: ['token'],
      });
      const jetons = [...new Set(appareils.map((a) => a.token).filter(Boolean))];
      if (jetons.length === 0) return;

      // FCM plafonne un envoi multicast à 500 destinataires.
      const lots = [];
      for (let i = 0; i < jetons.length; i += 500) lots.push(jetons.slice(i, i + 500));

      for (const lot of lots) {
        const reponse = await messaging.sendEachForMulticast({
          tokens: lot,
          notification: {
            title: payload.titre,
            body: payload.message || '',
          },
          data: {
            // FCM n'accepte que des chaînes dans `data`.
            type: String(payload.type ?? ''),
            donnees: payload.donnees ? JSON.stringify(payload.donnees) : '',
          },
          android: {
            priority: 'high',
            notification: {
              // Doit correspondre au canal créé côté mobile
              // (`push_service.dart`) : un identifiant inconnu et Android
              // retombe sur un canal par défaut sans son ni vibration.
              channelId: 'suivi_chantier_alertes',
              icon: 'ic_notification',
              color: '#F2600C',
              defaultSound: true,
            },
          },
          apns: {
            payload: {
              aps: { sound: 'default', badge: 1, 'mutable-content': 1 },
            },
          },
        });

        await NotificationService._purgerJetonsInvalides(lot, reponse);
      }
    } catch (err) {
      logger.warn('[push] Envoi impossible :', err.message);
    }
  }

  /**
   * Supprime les jetons que FCM déclare morts.
   *
   * Sans ce ménage, la table enfle à chaque réinstallation d'application et
   * chaque envoi traîne des destinataires fantômes — jusqu'à dépasser les
   * quotas pour rien. Seules ces deux erreurs signifient « ce jeton n'existe
   * plus » ; les autres (panne, quota) sont temporaires et ne doivent surtout
   * pas provoquer de suppression.
   */
  static async _purgerJetonsInvalides(jetons, reponse) {
    const morts = [];
    reponse.responses.forEach((resultat, i) => {
      const code = resultat.error?.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        morts.push(jetons[i]);
      }
    });

    if (morts.length === 0) return;
    await DeviceToken.destroy({ where: { token: morts } });
    logger.info(`[push] ${morts.length} jeton(s) périmé(s) supprimé(s)`);
  }
}

module.exports = NotificationService;
