'use strict';

const { Op } = require('sequelize');
const { Utilisateur, Organisation } = require('../../../models/index.js');
const AuditLogService = require('./auditLog.service.js');
const {
  sendInscriptionValideeEmail,
  sendInscriptionRejeteeEmail,
} = require('../../../infrastructure/emailService.js');
const { SAFE_USER_ATTRIBUTES } = require('../../../utils/formatUser.js');
const escapeLike = require('../../../utils/escapeLike.js');
const logger = require('../../../utils/logger.js');

/**
 * Demandes d'inscription — SUPER-ADMIN plateforme (rôle 'Admin').
 *
 * L'inscription publique dépose un compte en 'en_attente_validation' (voir
 * auth.service.js#register). Ce service est le seul point où cette demande est
 * tranchée : validation (le compte devient actif) ou rejet motivé.
 *
 * Dans les deux cas le demandeur est prévenu par email. L'envoi est
 * best-effort — un échec Resend ne doit pas annuler une décision déjà prise et
 * enregistrée : l'admin verrait l'opération échouer alors que le compte a
 * changé d'état. L'échec est journalisé, pas propagé.
 */
class DemandeInscriptionService {

  /** Attributs exposés : les champs sûrs + la trace de décision. */
  static get ATTRIBUTS() {
    return [...SAFE_USER_ATTRIBUTES, 'motif_rejet', 'valide_par', 'valide_le'];
  }

  // -------------------- LISTER LES DEMANDES --------------------
  /**
   * @param {{ page?: number, limit?: number, search?: string, statut?: string }} params
   *   `statut` filtre l'onglet affiché ; par défaut, seules les demandes
   *   EN ATTENTE remontent — c'est la file de travail de l'admin.
   */
  static async listDemandes({ page = 1, limit = 20, search = '', statut } = {}) {
    const statutsGeres = ['en_attente_validation', 'rejete', 'actif'];
    const where = {};

    if (statut && statutsGeres.includes(statut)) {
      where.statut = statut;
    } else {
      where.statut = 'en_attente_validation';
    }

    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { prenom: { [Op.iLike]: motif } },
        { email: { [Op.iLike]: motif } },
      ];
    }

    const { rows, count } = await Utilisateur.findAndCountAll({
      where,
      attributes: DemandeInscriptionService.ATTRIBUTS,
      include: [{
        model: Organisation,
        as: 'organisation',
        attributes: ['id', 'nom', 'raison_sociale', 'siret', 'ville', 'pays', 'telephone', 'email'],
      }],
      // Les plus anciennes d'abord : une file d'attente se traite dans l'ordre
      // d'arrivée, sinon les demandes du bas ne sont jamais vues.
      order: [['createdAt', 'ASC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return { success: true, demandes: rows, total: count };
  }

  // -------------------- COMPTEUR (pastille du menu) --------------------
  static async compterEnAttente() {
    const total = await Utilisateur.count({ where: { statut: 'en_attente_validation' } });
    return { success: true, total };
  }

  // -------------------- DÉTAIL --------------------
  static async getDemande(id) {
    const demande = await Utilisateur.findByPk(id, {
      attributes: DemandeInscriptionService.ATTRIBUTS,
      include: [{ model: Organisation, as: 'organisation' }],
    });
    if (!demande) return { success: false, message: 'Demande introuvable' };
    return { success: true, demande };
  }

  // -------------------- VALIDER --------------------
  /**
   * Active le compte et lui attribue son rôle définitif.
   *
   * @param {string} id
   * @param {{ role?: string }} data  Rôle choisi par l'admin. Absent = on garde
   *   celui demandé à l'inscription ('Entreprise').
   */
  static async valider(id, { role } = {}, admin, ip) {
    const demande = await Utilisateur.findByPk(id, {
      include: [{ model: Organisation, as: 'organisation', attributes: ['nom'] }],
    });
    if (!demande) return { success: false, message: 'Demande introuvable' };

    if (demande.statut !== 'en_attente_validation') {
      return {
        success: false,
        message: 'Cette demande a déjà été traitée.',
      };
    }

    const updates = {
      statut: 'actif',
      motif_rejet: null,
      valide_par: admin.id,
      valide_le: new Date(),
    };
    if (role) updates.role = role;

    await demande.update(updates);

    await AuditLogService.logAction({
      admin,
      action: 'inscription.validation',
      cibleType: 'utilisateur',
      cibleId: demande.id,
      details: { email: demande.email, role: updates.role || demande.role },
      ip,
    });

    sendInscriptionValideeEmail({
      to: demande.email,
      nom: demande.nom,
      prenom: demande.prenom,
      organisationNom: demande.organisation?.nom,
    }).catch((err) => logger.warn('[email] Activation non envoyée :', err.message));

    return { success: true, message: 'Demande validée. Le demandeur a été prévenu par email.', demande };
  }

  // -------------------- REJETER --------------------
  /**
   * Refuse la demande. `motif` est obligatoire (imposé par le schéma Joi) :
   * il part tel quel dans l'email et constitue la seule explication reçue.
   */
  static async rejeter(id, { motif }, admin, ip) {
    const demande = await Utilisateur.findByPk(id, {
      include: [{ model: Organisation, as: 'organisation', attributes: ['nom'] }],
    });
    if (!demande) return { success: false, message: 'Demande introuvable' };

    if (demande.statut !== 'en_attente_validation') {
      return { success: false, message: 'Cette demande a déjà été traitée.' };
    }

    const motifPropre = String(motif).trim();

    await demande.update({
      statut: 'rejete',
      motif_rejet: motifPropre,
      valide_par: admin.id,
      valide_le: new Date(),
    });

    await AuditLogService.logAction({
      admin,
      action: 'inscription.rejet',
      cibleType: 'utilisateur',
      cibleId: demande.id,
      details: { email: demande.email, motif: motifPropre },
      ip,
    });

    sendInscriptionRejeteeEmail({
      to: demande.email,
      nom: demande.nom,
      prenom: demande.prenom,
      motif: motifPropre,
      organisationNom: demande.organisation?.nom,
    }).catch((err) => logger.warn('[email] Rejet non envoyé :', err.message));

    return { success: true, message: 'Demande rejetée. Le demandeur a été prévenu par email.', demande };
  }
}

module.exports = DemandeInscriptionService;
