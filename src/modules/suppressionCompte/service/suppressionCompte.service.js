'use strict';

const { Op } = require('sequelize');
const { DemandeSuppression } = require('../../../models/index.js');
const { sendDemandeSuppressionEmail } = require('../../../infrastructure/emailService.js');
const escapeLike = require('../../../utils/escapeLike.js');
const logger = require('../../../utils/logger.js');

/**
 * Demandes de suppression de compte (RGPD art. 17 / exigence Google Play).
 *
 * Deux publics, deux niveaux d'accès :
 *   - le DEMANDEUR dépose depuis la page publique `/suppression-compte`, sans
 *     compte ni connexion — il a pu désinstaller l'application ;
 *   - l'ADMIN plateforme consulte la file et traite les demandes.
 *
 * La suppression elle-même n'est PAS automatisée ici, et c'est délibéré :
 * l'adresse saisie n'est pas authentifiée. Supprimer sur simple déclaration
 * ouvrirait une porte à la destruction du compte d'autrui — il suffirait de
 * connaître une adresse email. L'admin vérifie l'identité, puis agit.
 */
class SuppressionCompteService {

  /** Champs exposés à l'admin. `ip` reste interne au détail. */
  static get ATTRIBUTS() {
    return ['id', 'email', 'objet', 'statut', 'ip', 'traite_par', 'traite_le', 'note_admin', 'createdAt'];
  }

  // -------------------- DÉPÔT (public) --------------------
  /**
   * Enregistre la demande, puis notifie l'équipe par email.
   *
   * @param {{ email: string, objet: string }} data — déjà validés par Joi.
   * @param {string} [ip] — trace d'origine, best-effort.
   */
  static async creer({ email, objet }, ip) {
    const emailNormalise = String(email).trim().toLowerCase();

    // Anti-doublon : une même adresse qui redépose alors qu'une demande est
    // déjà EN ATTENTE ne crée pas une seconde ligne. Sans ce garde-fou, un
    // visiteur inquiet qui clique trois fois remplit la file de la même
    // demande, et l'équipe traite trois fois le même dossier.
    const existante = await DemandeSuppression.findOne({
      where: { email: emailNormalise, statut: 'en_attente' },
    });

    if (existante) {
      return {
        success: true,
        dejaEnregistree: true,
        message: 'Une demande est déjà en cours de traitement pour cette adresse.',
        demande: existante,
      };
    }

    const demande = await DemandeSuppression.create({
      email: emailNormalise,
      objet: String(objet).trim(),
      ip: ip ? String(ip).slice(0, 64) : null,
      statut: 'en_attente',
    });

    // Best-effort, comme les autres envois du projet : une panne Resend ne
    // doit pas faire échouer le dépôt côté visiteur. La demande est déjà en
    // base, donc récupérable depuis l'administration même si l'email se perd.
    try {
      await sendDemandeSuppressionEmail({
        email: demande.email,
        objet: demande.objet,
        date: new Date(demande.createdAt).toLocaleString('fr-FR'),
        ip: demande.ip,
      });
    } catch (err) {
      logger.error('[suppression-compte] Notification email échouée :', err.message);
    }

    return { success: true, dejaEnregistree: false, demande };
  }

  // -------------------- LISTE (admin) --------------------
  /**
   * @param {{ page?: number, limit?: number, search?: string, statut?: string }} params
   *   Sans `statut`, TOUT est renvoyé — contrairement aux demandes
   *   d'inscription, l'admin a besoin de l'historique pour prouver qu'une
   *   demande a bien été traitée en cas de contrôle.
   */
  static async lister({ page = 1, limit = 20, search = '', statut } = {}) {
    const statutsGeres = ['en_attente', 'traitee', 'rejetee'];
    const where = {};

    if (statut && statutsGeres.includes(statut)) where.statut = statut;

    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { email: { [Op.iLike]: motif } },
        { objet: { [Op.iLike]: motif } },
      ];
    }

    const { rows, count } = await DemandeSuppression.findAndCountAll({
      where,
      attributes: SuppressionCompteService.ATTRIBUTS,
      // Les plus anciennes d'abord : le délai RGPD de 30 jours court depuis la
      // réception, c'est donc la plus ancienne qui est la plus urgente.
      // `id` départage les demandes du même instant : sans lui, l'ordre entre
      // deux pages n'est pas garanti (doublons ou lignes sautées).
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { demandes: rows, total: count };
  }

  // -------------------- COMPTEUR (admin) --------------------
  /** Alimente la pastille du menu, comme pour les demandes d'inscription. */
  static async compterEnAttente() {
    const total = await DemandeSuppression.count({ where: { statut: 'en_attente' } });
    return { total };
  }

  // -------------------- TRAITEMENT (admin) --------------------
  /**
   * Marque une demande comme traitée ou rejetée.
   *
   * Ne supprime AUCUNE donnée : c'est une trace de décision. La suppression
   * effective passe par les outils existants (`/account/delete-account` ou la
   * gestion des utilisateurs), après vérification d'identité.
   */
  static async traiter(id, { statut, note_admin }, admin) {
    const demande = await DemandeSuppression.findByPk(id);
    if (!demande) return { success: false, message: 'Demande introuvable' };

    // Une décision est une TRACE : elle ne se réécrit pas. Deux admins sur la
    // même demande (ou un double clic) écrasaient l'auteur, la date et la note
    // de la première décision. La mise à jour est conditionnelle au statut
    // « en_attente », tel que la base le voit au moment de l'écriture.
    const decision = {
      statut,
      note_admin: note_admin ? String(note_admin).trim() : null,
      traite_par: admin?.id ?? null,
      traite_le: new Date(),
    };
    const [n] = await DemandeSuppression.update(decision, { where: { id, statut: 'en_attente' } });
    if (!n) return { success: false, message: 'Cette demande a déjà été traitée.' };
    Object.assign(demande, decision);

    return { success: true, message: 'Demande mise à jour', demande };
  }
}

module.exports = SuppressionCompteService;
