'use strict';

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { Utilisateur, Organisation } = require('../../../models/index.js');
const { bcryptConfig } = require('../../../config/security.js');
const AuditLogService = require('./auditLog.service.js');
const AccountService = require('../../account/service/account.service.js');
const { SAFE_USER_ATTRIBUTES } = require('../../../utils/formatUser.js');
const escapeLike = require('../../../utils/escapeLike.js');

/**
 * Gestion des utilisateurs — SUPER-ADMIN plateforme (rôle 'Admin').
 * Portée globale : agit sur tous les utilisateurs de toutes les organisations.
 */
class GestionUtilisateurService {

  // -------------------- LISTER LES UTILISATEURS --------------------
  static async listUtilisateurs({ page = 1, limit = 20, search = '', role, statut, organisationId } = {}) {
    const where = {};
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { prenom: { [Op.iLike]: motif } },
        { email: { [Op.iLike]: motif } },
      ];
    }
    if (role) where.role = role;
    if (statut) where.statut = statut;
    if (organisationId) where.organisationId = organisationId;

    const { rows, count } = await Utilisateur.findAndCountAll({
      where,
      // Attributs sûrs uniquement — mfa_secret et compteurs ne sortent jamais.
      attributes: SAFE_USER_ATTRIBUTES,
      include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return { success: true, utilisateurs: rows, total: count };
  }

  // -------------------- DÉTAIL D'UN UTILISATEUR --------------------
  static async getUtilisateur(utilisateurId) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId, {
      attributes: SAFE_USER_ATTRIBUTES,
      include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom', 'abonnement'] }],
    });
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    return { success: true, utilisateur };
  }

  // -------------------- CRÉER UN UTILISATEUR --------------------
  static async creerUtilisateur(data, admin, ip) {
    if (data.email) {
      const emailClean = data.email.trim().toLowerCase();
      const exist = await Utilisateur.findOne({ where: { email: emailClean } });
      if (exist) return { success: false, message: 'Cet email est déjà utilisé' };
      data.email = emailClean;
    }

    if (data.telephone) {
      const telExist = await Utilisateur.findOne({ where: { telephone: data.telephone } });
      if (telExist) return { success: false, message: 'Ce numéro de téléphone est déjà utilisé' };
    }

    if (data.organisationId) {
      const org = await Organisation.findByPk(data.organisationId);
      if (!org) return { success: false, message: 'Organisation introuvable' };
    }

    const utilisateur = await Utilisateur.create({
      organisationId: data.organisationId || null,
      nom: data.nom,
      prenom: data.prenom,
      email: data.email,
      mot_de_passe: await bcrypt.hash(data.mot_de_passe || 'Temp1234!', bcryptConfig.saltRounds),
      telephone: data.telephone || null,
      fonction: data.fonction || null,
      role: data.role || 'ConducteurTravaux',
      // 'actif' par défaut, et non 'en_attente_validation' : ce statut est
      // devenu BLOQUANT (il désigne une demande d'inscription publique non
      // tranchée). Un compte créé par le super-admin est déjà validé par
      // définition — le laisser en attente l'enfermerait dehors en attendant
      // qu'on valide une demande qui n'existe pas.
      statut: data.statut || 'actif',
      permissions: data.permissions || null,
      mdp_temporaire: true,   // mot de passe par défaut → rotation obligatoire au 1er login
      email_verifie: true,    // créé par un acteur de confiance (super-admin)
    });

    await AuditLogService.logAction({
      admin, action: 'utilisateur.creation', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { email: utilisateur.email }, ip,
    });

    return { success: true, message: 'Utilisateur créé avec succès', utilisateur };
  }

  // -------------------- MODIFIER UN UTILISATEUR --------------------
  static async modifierUtilisateur(utilisateurId, data, admin, ip) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };

    const updates = {};
    for (const champ of ['nom', 'prenom', 'telephone', 'fonction', 'statut', 'permissions', 'organisationId']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (data.email && data.email.trim().toLowerCase() !== utilisateur.email) {
      const emailClean = data.email.trim().toLowerCase();
      const exist = await Utilisateur.findOne({ where: { email: emailClean } });
      if (exist) return { success: false, message: 'Cet email est déjà utilisé' };
      updates.email = emailClean;
    }
    if (data.mot_de_passe) {
      updates.mot_de_passe = await bcrypt.hash(data.mot_de_passe, bcryptConfig.saltRounds);
    }

    await utilisateur.update(updates);

    // Ne jamais journaliser le mot de passe (ni même son hash) dans l'audit
    const { mot_de_passe: _ignore, ...detailsSurs } = updates;
    await AuditLogService.logAction({
      admin, action: 'utilisateur.modification', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: detailsSurs, ip,
    });

    return { success: true, message: 'Utilisateur mis à jour', utilisateur };
  }

  // -------------------- CHANGER LE RÔLE --------------------
  static async changerRole(utilisateurId, role, admin, ip) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    if (utilisateur.id === admin.id) {
      return { success: false, message: 'Vous ne pouvez pas modifier votre propre rôle' };
    }

    await utilisateur.update({ role });

    await AuditLogService.logAction({
      admin, action: 'utilisateur.role.change', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { ancien: utilisateur.role, nouveau: role }, ip,
    });

    return { success: true, message: 'Rôle modifié avec succès', utilisateur };
  }

  // -------------------- GÉRER LES PERMISSIONS --------------------
  static async modifierPermissions(utilisateurId, permissions, admin, ip) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };

    await utilisateur.update({ permissions });

    await AuditLogService.logAction({
      admin, action: 'utilisateur.permissions.change', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { permissions }, ip,
    });

    return { success: true, message: 'Permissions mises à jour', utilisateur };
  }

  // -------------------- SUPPRIMER UN UTILISATEUR --------------------
  static async supprimerUtilisateur(utilisateurId, admin, ip) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    if (utilisateur.id === admin.id) {
      return { success: false, message: 'Vous ne pouvez pas supprimer votre propre compte' };
    }

    // RGPD art. 17 — ce chemin ne faisait qu'un `destroy()` paranoid : nom,
    // prénom, email, téléphone, photo et fonction restaient en base en clair,
    // indéfiniment, alors que c'est le chemin de suppression réellement utilisé.
    // On applique donc exactement le même traitement que l'auto-suppression :
    // implémentation unique dans AccountService.pseudonymiserEtSupprimer
    // (pseudonymisation du profil + anonymisation des journaux de connexion +
    // révocation des sessions, puis suppression logique).
    await AccountService.pseudonymiserEtSupprimer(utilisateur);

    // L'audit ne recopie plus l'email de la personne supprimée.
    // DÉCISION : l'inscrire dans `details` était contradictoire avec l'effacement
    // — audit_log est une table applicative en clair, lisible par tout
    // administrateur et exportée telle quelle ; l'email y survivait à la
    // pseudonymisation et rendait la personne réidentifiable (même problème que
    // ConnexionLog). La traçabilité de l'action reste entière : qui (adminId,
    // adminNom, adminEmail — l'auteur de l'action, pas la victime), quoi
    // (action), sur qui (cibleId = UUID interne, joignable à la ligne
    // pseudonymisée), quand et depuis quelle IP. L'email en clair n'ajoutait
    // rien à la traçabilité que cibleId n'apporte déjà.
    await AuditLogService.logAction({
      admin, action: 'utilisateur.suppression', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { rgpd: 'profil pseudonymisé' }, ip,
    });

    return { success: true, message: 'Utilisateur supprimé' };
  }
}

module.exports = GestionUtilisateurService;
