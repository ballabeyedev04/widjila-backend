'use strict';

// bcrypt NATIF (hors boucle d'événements) — voir utils/motDePasse.js.
const bcrypt = require('../../../utils/motDePasse.js');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { Utilisateur, Organisation, RefreshToken } = require('../../../models/index.js');
const { bcryptConfig } = require('../../../config/security.js');
const { sendNouveauMembreEmail } = require('../../../infrastructure/emailService.js');
const { libelleRole } = require('../../../utils/libelleRole.js');
const logger = require('../../../utils/logger.js');
const AuditLogService = require('./auditLog.service.js');
const AccountService = require('../../account/service/account.service.js');
const { SAFE_USER_ATTRIBUTES } = require('../../../utils/formatUser.js');
const escapeLike = require('../../../utils/escapeLike.js');
const sequelize = require('../../../config/db.js');
const EssaiService = require('../../subscription/service/essai.service.js');

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

    // Seul le super-admin plateforme vit sans organisation. Tout autre rôle
    // travaille sur des ressources rattachées à `organisationId` : un compte
    // créé sans organisation est inutilisable — il traverse l'authentification
    // puis échoue à la première création (contrainte NOT NULL en base) et ne
    // voit aucune donnée dans les listes, toutes filtrées par organisation.
    // Le formulaire de la plateforme laisse le sélecteur vide par défaut :
    // l'oubli est silencieux, et se paie côté utilisateur final.
    const roleCible = data.role || 'ConducteurTravaux';
    if (!data.organisationId && roleCible !== 'Admin') {
      return { success: false, message: "Sélectionnez une organisation : seul le rôle Admin (super-admin plateforme) peut exister sans organisation." };
    }

    let org = null;
    if (data.organisationId) {
      org = await Organisation.findByPk(data.organisationId);
      if (!org) return { success: false, message: 'Organisation introuvable' };
    }

    // Mot de passe : celui choisi par l'administrateur, sinon un mot de passe
    // temporaire ALÉATOIRE, transmis une fois (courriel + réponse).
    //
    // CORRECTIF (audit sécurité) : le repli était une valeur LITTÉRALE écrite
    // dans ce fichier. L'écran de la plateforme envoyait sa saisie sous une
    // clé que le schéma ne connaît pas : elle était retirée par la validation,
    // et chaque compte créé depuis l'interface — `Admin` compris — recevait ce
    // même mot de passe public. `mdp_temporaire` n'étant qu'une indication
    // pour les clients, connaître l'adresse d'un tel compte suffisait à s'y
    // connecter.
    let motDePasse = data.mot_de_passe;
    let motDePasseTemporaire = null;
    if (!motDePasse) {
      motDePasseTemporaire = crypto.randomBytes(12).toString('base64url');
      motDePasse = motDePasseTemporaire;
    }

    const utilisateur = await Utilisateur.create({
      organisationId: data.organisationId || null,
      nom: data.nom,
      prenom: data.prenom,
      email: data.email,
      mot_de_passe: await bcrypt.hash(motDePasse, bcryptConfig.saltRounds),
      telephone: data.telephone || null,
      fonction: data.fonction || null,
      role: roleCible,
      // 'actif' par défaut, et non 'en_attente_validation' : ce statut est
      // devenu BLOQUANT (il désigne une demande d'inscription publique non
      // tranchée). Un compte créé par le super-admin est déjà validé par
      // définition — le laisser en attente l'enfermerait dehors en attendant
      // qu'on valide une demande qui n'existe pas.
      statut: data.statut || 'actif',
      permissions: data.permissions || null,
      mdp_temporaire: true,   // connu de l'administrateur → à changer au 1er login
      email_verifie: true,    // créé par un acteur de confiance (super-admin)
    });

    // Le compte existe : une panne d'envoi ne doit pas le faire échouer (même
    // règle que l'invitation d'un membre, organisation.service.js). Le
    // résultat est renvoyé pour que l'écran sache s'il doit transmettre le
    // mot de passe lui-même.
    let emailEnvoye = false;
    if (motDePasseTemporaire) {
      try {
        const envoi = await sendNouveauMembreEmail({
          to: utilisateur.email,
          prenom: utilisateur.prenom,
          nom: utilisateur.nom,
          auteurNom: [admin?.prenom, admin?.nom].filter(Boolean).join(' ').trim() || "L'administration",
          organisationNom: org?.nom || 'SuivieChantier',
          role: libelleRole(utilisateur.role),
          motDePasse: motDePasseTemporaire,
        });
        emailEnvoye = envoi !== null;
      } catch (err) {
        logger.error(`[admin] Identifiants du nouveau compte non envoyés : ${err.message}`);
      }
    }

    await AuditLogService.logAction({
      admin, action: 'utilisateur.creation', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { email: utilisateur.email, role: utilisateur.role }, ip,
    });

    return {
      success: true, message: 'Utilisateur créé avec succès', utilisateur, motDePasseTemporaire, emailEnvoye,
    };
  }

  /**
   * Reste-t-il un AUTRE administrateur plateforme actif que `exclureId` ?
   *
   * Le rôle `Admin` est le seul à valider les inscriptions, tarifer les
   * formules et administrer les comptes. Désactiver, rétrograder ou supprimer
   * le dernier ferme la plateforme à tout le monde — sans autre issue qu'une
   * intervention directe en base.
   */
  static async _autreAdminActif(exclureId) {
    const n = await Utilisateur.count({
      where: { role: 'Admin', statut: 'actif', id: { [Op.ne]: exclureId } },
    });
    return n > 0;
  }

  // -------------------- MODIFIER UN UTILISATEUR --------------------
  static async modifierUtilisateur(utilisateurId, data, admin, ip) {
    const utilisateur = await Utilisateur.findByPk(utilisateurId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };

    // Un champ ne compte que s'il CHANGE : l'écran renvoie le formulaire
    // complet (statut, organisation, email) même quand on ne corrige qu'un nom.
    const normaliser = (v) => (v === '' || v === undefined ? null : v);
    const change = (champ) => data[champ] !== undefined
      && JSON.stringify(normaliser(data[champ])) !== JSON.stringify(normaliser(utilisateur[champ]));
    const emailChange = Boolean(data.email) && data.email.trim().toLowerCase() !== utilisateur.email;

    // ── Sur son propre compte ────────────────────────────────────────────
    // `changerRole` et `supprimerUtilisateur` refusaient déjà d'agir sur soi ;
    // cette route, non. Un admin pouvait s'y désactiver (seul admin : la
    // plateforme n'a plus personne pour l'administrer), se rattacher à une
    // organisation, ou changer son mot de passe et son adresse SANS fournir
    // le mot de passe actuel — le premier geste d'une session volée qui veut
    // s'installer. Ces changements passent par le profil (/account/*), qui
    // exige le mot de passe actuel et ferme les autres sessions.
    if (String(utilisateur.id) === String(admin?.id)) {
      const sensibles = ['statut', 'permissions', 'organisationId'].filter(change);
      if (sensibles.length || data.mot_de_passe || emailChange) {
        return {
          success: false,
          message: 'Vous ne pouvez pas modifier votre propre statut, organisation, permissions, email ou mot de passe '
            + "depuis l'administration. Utilisez votre profil.",
        };
      }
    }

    // ── Le dernier admin actif ───────────────────────────────────────────
    if (utilisateur.role === 'Admin' && utilisateur.statut === 'actif' && change('statut')
      && data.statut !== 'actif' && !(await GestionUtilisateurService._autreAdminActif(utilisateur.id))) {
      return { success: false, message: 'Impossible de désactiver le dernier administrateur actif de la plateforme.' };
    }

    const updates = {};
    for (const champ of ['nom', 'prenom', 'telephone', 'fonction', 'statut', 'permissions', 'organisationId']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (emailChange) {
      const emailClean = data.email.trim().toLowerCase();
      const exist = await Utilisateur.findOne({ where: { email: emailClean } });
      if (exist) return { success: false, message: 'Cet email est déjà utilisé' };
      updates.email = emailClean;
    }

    // ── Sessions de la cible ─────────────────────────────────────────────
    // Redéfinir un mot de passe, c'est presque toujours reprendre la main sur
    // un compte compromis. Les jetons déjà émis restaient pourtant valables :
    // une heure pour l'accès, sept jours RENOUVELABLES pour le refresh. Même
    // traitement que `account.service#resetPassword` : `token_version` périme
    // les jetons d'accès, la révocation des refresh tokens empêche d'en
    // obtenir d'autres. Une désactivation ferme aussi les sessions — le
    // contrôle par requête (`auth.middleware`) la rendait déjà effective,
    // ceci retire en plus les refresh tokens devenus sans objet.
    let fermerSessions = false;
    if (data.mot_de_passe) {
      updates.mot_de_passe = await bcrypt.hash(data.mot_de_passe, bcryptConfig.saltRounds);
      updates.mdp_temporaire = true; // connu de l'administrateur → à changer
      updates.token_version = (utilisateur.token_version || 0) + 1;
      fermerSessions = true;
    }
    if (updates.statut !== undefined && updates.statut !== 'actif') fermerSessions = true;

    // Cet écran est la SECONDE porte d'entrée vers un compte actif : le
    // super-admin peut y débloquer une inscription en attente sans passer par
    // l'écran « Demandes ». L'essai doit démarrer ici aussi, sinon
    // l'organisation ouverte par ce chemin garde un `trial_ends_at` NULL,
    // c'est-à-dire un essai réputé TERMINÉ (config/essai.js) — et se heurte
    // au mur de l'abonnement dès sa première connexion.
    const activation = updates.statut === 'actif'
      && utilisateur.statut === 'en_attente_validation';

    const t = await sequelize.transaction();
    try {
      await utilisateur.update(updates, { transaction: t });
      if (fermerSessions) {
        await RefreshToken.update(
          { revoked: true },
          { where: { utilisateurId: utilisateur.id, revoked: false }, transaction: t }
        );
      }
      if (activation) {
        // APRÈS l'écriture, à dessein : cet écran permet aussi de déplacer un
        // compte d'une organisation à l'autre. L'instance porte alors déjà la
        // nouvelle, et c'est bien l'essai de celle où le compte atterrit qu'il
        // faut démarrer.
        await EssaiService.demarrerEssai(utilisateur.organisationId, { transaction: t });
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    // Ne jamais journaliser le mot de passe (ni même son hash) dans l'audit
    const { mot_de_passe: _ignore, token_version: _tv, ...detailsSurs } = updates;
    if (data.mot_de_passe) detailsSurs.motDePasseRedefini = true;
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
    if (utilisateur.role === 'Admin' && role !== 'Admin' && utilisateur.statut === 'actif'
      && !(await GestionUtilisateurService._autreAdminActif(utilisateur.id))) {
      return { success: false, message: 'Impossible de rétrograder le dernier administrateur actif de la plateforme.' };
    }

    // Lu AVANT l'écriture : l'audit inscrivait `utilisateur.role` APRÈS
    // `update`, c'est-à-dire le nouveau rôle dans « ancien » — le journal
    // disait « Admin → Admin » pour une promotion.
    const ancienRole = utilisateur.role;
    await utilisateur.update({ role });

    await AuditLogService.logAction({
      admin, action: 'utilisateur.role.change', cibleType: 'utilisateur',
      cibleId: utilisateur.id, details: { ancien: ancienRole, nouveau: role }, ip,
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
    if (utilisateur.role === 'Admin' && utilisateur.statut === 'actif'
      && !(await GestionUtilisateurService._autreAdminActif(utilisateur.id))) {
      return { success: false, message: 'Impossible de supprimer le dernier administrateur actif de la plateforme.' };
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
