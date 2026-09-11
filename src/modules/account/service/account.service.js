'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Utilisateur, UserOtp, ConnexionLog, RefreshToken, MfaChallenge, DeviceToken,
  Notification, Commentaire, Reserve, ReserveHistorique, Media, Signature, Annotation,
} = require('../../../models/index.js');
const { bcryptConfig } = require('../../../config/security.js');
const { sendOtpEmail } = require('../../../infrastructure/emailService.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const MfaService = require('../../auth/service/mfa.service.js');
const { genererAccessToken } = require('../../auth/service/auth.service.js');
const logger = require('../../../utils/logger.js');
const { SAFE_USER_ATTRIBUTES } = require('../../../utils/formatUser.js');
const hashToken = require('../../../utils/hashToken.js');

// Hash constant pour égaliser le temps de réponse (anti énumération par timing)
const DUMMY_HASH = '$2b$12$LmKBP5z6RvWnAnsFOVK9Qeq7C2JKvPAzTq/xz7rJa2Y5m.JnHkTFO';

// Plafond par catégorie de l'export de portabilité (art. 20). Sans plafond, un
// compte ancien peut charger des dizaines de milliers de lignes en mémoire et
// sérialiser un JSON de plusieurs centaines de Mo dans la réponse HTTP.
const EXPORT_MAX_PAR_CATEGORIE = 500;

class AccountService {

  // -------------------- PROFIL COURANT --------------------
  static async getMe(userId) {
    const utilisateur = await Utilisateur.findByPk(userId, {
      attributes: SAFE_USER_ATTRIBUTES,
    });
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    return { success: true, utilisateur };
  }

  // -------------------- MODIFIER LE PROFIL --------------------
  /**
   * Met à jour les informations personnelles (champs fournis uniquement).
   *
   * L'EMAIL N'EST PAS MODIFIABLE ICI, volontairement. Le champ est absent de
   * `updateProfilSchema` et le middleware valide avec `stripUnknown: true` :
   * un client qui l'enverrait le verrait retiré avant d'arriver jusqu'ici.
   *
   * Ne pas l'ajouter sans construire le circuit de vérification qui va avec.
   * L'email est l'identifiant de connexion ET la cible de « mot de passe
   * oublié » : le changer sans repasser `email_verifie` à faux et sans
   * envoyer un lien de confirmation transformerait une session détournée
   * quelques minutes en prise de contrôle définitive du compte.
   *
   * @param {string} userId
   * @param {object} data — champs à mettre à jour
   * @param {object} [files] — req.files (photoProfil)
   */
  static async modifierInfoPersonnelles(userId, data, files = {}) {
    const { nom, prenom, telephone, fonction, langue } = data;

    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };

    if (telephone && telephone !== utilisateur.telephone) {
      const telExist = await Utilisateur.findOne({ where: { telephone } });
      if (telExist) return { success: false, message: 'Ce numéro de téléphone est déjà utilisé' };
    }

    const updates = {};
    // `nom`, `prenom` et `langue` : un test de vérité suffit, Joi rejette déjà
    // la chaîne vide (min 2 / liste fermée) — il n'existe donc pas de cas où
    // l'on voudrait les effacer.
    if (nom) updates.nom = nom;
    if (prenom) updates.prenom = prenom;
    if (langue) updates.langue = langue;

    // `telephone` et `fonction` sont FACULTATIFS et le schéma accepte '' /
    // null pour eux : le test doit donc porter sur la PRÉSENCE du champ, pas
    // sur sa vérité. Avec `if (telephone)`, vider son numéro depuis le profil
    // n'avait aucun effet — la requête partait, répondait 200, et l'ancienne
    // valeur restait en base sans que rien ne le signale.
    if (telephone !== undefined) updates.telephone = telephone || null;
    if (fonction !== undefined) updates.fonction = fonction || null;

    // L'ancienne photo doit être effacée du disque : sans cela, chaque
    // changement d'avatar laissait un fichier orphelin — une donnée personnelle
    // (portrait) conservée indéfiniment, hors de portée du droit à l'effacement.
    let anciennePhoto = null;
    if (files.photoProfil && files.photoProfil[0]) {
      anciennePhoto = utilisateur.photoProfil;
      updates.photoProfil = await storeFile(files.photoProfil[0].buffer, files.photoProfil[0].originalname, 'profils');
    }

    await utilisateur.update(updates);

    // Best-effort APRÈS l'écriture en base : un échec de suppression ne doit
    // jamais faire échouer la mise à jour du profil.
    if (anciennePhoto && anciennePhoto !== updates.photoProfil) {
      await deleteFile(anciennePhoto).catch(() => {});
    }

    return { success: true, message: 'Informations mises à jour avec succès', utilisateur };
  }

  // -------------------- MOT DE PASSE OUBLIÉ (OTP) --------------------
  static _generateOtp(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans O,0,I,1 (lisibilité)
    let otp = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      otp += chars[bytes[i] % chars.length];
    }
    return otp;
  }

  static async forgotPassword(email) {
    // Message UNIQUE, quel que soit le résultat de la recherche — un texte
    // différent selon que le compte existe ou non (même à statut HTTP 200
    // identique) reste un canal d'énumération de comptes par email : un
    // attaquant scripte des essais et distingue les deux cas au texte reçu.
    const MESSAGE_GENERIQUE = 'Si un compte existe avec cet email, un code de réinitialisation vient de lui être envoyé.';

    const utilisateur = await Utilisateur.findOne({ where: { email: email.toLowerCase() } });
    if (!utilisateur || utilisateur.role === 'Admin') {
      // Même COÛT que le chemin nominal (audit sécurité — énumération par
      // durée). Le message était déjà identique, mais un compte existant
      // déclenchait un hachage bcrypt (~250 ms) que l'absence de compte
      // sautait : chronométrer la réponse suffisait à distinguer les deux.
      await bcrypt.hash(AccountService._generateOtp(6), bcryptConfig.saltRounds);
      return { message: MESSAGE_GENERIQUE };
    }

    const otp = AccountService._generateOtp(6);
    const otpHash = await bcrypt.hash(otp, bcryptConfig.saltRounds);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await UserOtp.destroy({ where: { utilisateurId: utilisateur.id } });
    await UserOtp.create({ utilisateurId: utilisateur.id, otpHash, expiresAt });

    // Envoi NON attendu (audit sécurité — énumération par erreur et par durée).
    //
    // Attendu, il posait deux problèmes : sa durée réseau ne s'appliquait
    // qu'aux comptes existants, et son ÉCHEC — fournisseur de courriel en
    // panne — faisait répondre 500 pour un compte existant contre 200 pour un
    // compte inconnu. L'échec est journalisé côté serveur ; la réponse, elle,
    // ne dit plus rien de l'existence du compte.
    sendOtpEmail({ to: utilisateur.email, nom: utilisateur.prenom, otp })
      .catch((err) => logger.error(`[forgotPassword] envoi du code impossible : ${err.message}`));

    return { message: MESSAGE_GENERIQUE };
  }

  // -------------------- RÉINITIALISATION MOT DE PASSE (OTP) --------------------
  static async resetPassword(email, otpRecu, newPassword) {
    const utilisateur = await Utilisateur.findOne({ where: { email: email.toLowerCase() } });
    if (!utilisateur) {
      // Égaliser le temps de réponse — ne pas révéler l'existence du compte (audit L1)
      await bcrypt.compare(otpRecu || '', DUMMY_HASH);
      return { error: 'Code de réinitialisation invalide ou expiré.' };
    }

    const otpRecord = await UserOtp.findOne({ where: { utilisateurId: utilisateur.id } });
    if (!otpRecord) {
      return { error: 'Code de réinitialisation invalide ou expiré.' };
    }

    if (new Date() > otpRecord.expiresAt) {
      await otpRecord.destroy();
      return { error: 'Code de réinitialisation invalide ou expiré.' };
    }

    const isValid = await bcrypt.compare(otpRecu, otpRecord.otpHash);
    if (!isValid) return { error: 'Code de réinitialisation invalide ou expiré.' };

    if (newPassword.length < 8) {
      return { error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' };
    }

    const hashedPassword = await bcrypt.hash(newPassword, bcryptConfig.saltRounds);
    utilisateur.mot_de_passe = hashedPassword;
    utilisateur.mdp_temporaire = false; // rotation effectuée
    // Réinitialisation = compromission présumée : on ferme TOUT, sans
    // exception. Contrairement au changement de mot de passe, il n'y a ici
    // aucune session « courante » à épargner — l'utilisateur n'est pas
    // authentifié, il se reconnectera avec son nouveau mot de passe.
    //
    // Les deux gestes sont nécessaires et complémentaires : incrémenter
    // `token_version` périme les tokens d'ACCÈS déjà signés, révoquer les
    // refresh tokens empêche d'en obtenir de nouveaux. L'un sans l'autre
    // laisse une porte ouverte.
    utilisateur.token_version = (utilisateur.token_version || 0) + 1;
    await utilisateur.save();
    await otpRecord.destroy();

    await RefreshToken.update(
      { revoked: true },
      { where: { utilisateurId: utilisateur.id, revoked: false } }
    );

    return { message: 'Mot de passe réinitialisé avec succès.' };
  }

  // -------------------- CHANGER MOT DE PASSE --------------------
  /**
   * Change le mot de passe et RÉVOQUE les autres sessions.
   *
   * Sans cette révocation, un attaquant ayant dérobé un refresh token gardait
   * l'accès au compte même après que la victime a changé son mot de passe —
   * c'est-à-dire précisément après le geste censé lui reprendre la main.
   *
   * [refreshTokenActuel] désigne la session de l'appareil qui fait la demande,
   * épargnée pour ne pas déconnecter l'utilisateur au moment même où il
   * sécurise son compte. S'il est absent (client plus ancien, appel direct),
   * on révoque TOUT : mieux vaut une reconnexion de trop qu'une session
   * volée laissée ouverte.
   */
  static async changePassword(userId, oldPassword, newPassword, refreshTokenActuel = null) {
    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { error: 'Utilisateur non trouvé.' };

    const isMatch = await bcrypt.compare(oldPassword, utilisateur.mot_de_passe);
    if (!isMatch) return { error: 'Mot de passe actuel incorrect.' };

    if (newPassword.length < 8) {
      return { error: 'Le mot de passe doit contenir au moins 8 caractères.' };
    }

    utilisateur.mot_de_passe = await bcrypt.hash(newPassword, bcryptConfig.saltRounds);
    utilisateur.mdp_temporaire = false; // mot de passe temporaire remplacé
    // Périme TOUS les tokens d'accès en circulation, celui de l'appelant
    // compris — un JWT signé ne peut pas être annulé sélectivement. C'est ce
    // qui ferme la fenêtre pendant laquelle un token volé restait valable
    // (jusqu'à `JWT_EXPIRES_IN`) après le changement de mot de passe.
    utilisateur.token_version = (utilisateur.token_version || 0) + 1;
    await utilisateur.save();

    const where = { utilisateurId: userId, revoked: false };
    if (refreshTokenActuel) {
      where.tokenHash = { [Op.ne]: hashToken(refreshTokenActuel) };
    }
    const sessionsRevoquees = await RefreshToken.update({ revoked: true }, { where });

    return {
      message: 'Mot de passe modifié avec succès.',
      // Nombre de sessions fermées — l'interface peut ainsi dire à
      // l'utilisateur ce qui vient réellement de se passer sur ses autres
      // appareils, au lieu de le laisser le découvrir à la prochaine
      // ouverture.
      sessionsRevoquees: Array.isArray(sessionsRevoquees) ? sessionsRevoquees[0] : 0,
      // Token d'accès neuf, portant la nouvelle version : sans lui, l'appareil
      // qui vient de sécuriser son compte serait déconnecté par sa propre
      // action à la requête suivante. Son refresh token, lui, a été épargné
      // plus haut — la session continue sans rien redemander.
      accessToken: genererAccessToken(utilisateur),
    };
  }

  // -------------------- EFFACEMENT (RGPD art. 17) — IMPLÉMENTATION UNIQUE --------------------
  /**
   * Pseudonymise TOUTES les données identifiantes d'un utilisateur puis le
   * supprime en logique (paranoid).
   *
   * Point d'entrée unique volontairement partagé par les TROIS chemins de
   * suppression de l'application — auparavant seul `deleteAccount` faisait
   * quelque chose, et de façon incomplète :
   *   1. AccountService.deleteAccount                  — l'utilisateur lui-même
   *   2. GestionUtilisateurService.supprimerUtilisateur — super-admin plateforme
   *   3. OrganisationService.supprimerMembre           — admin d'organisation
   * Les chemins 2 et 3 (les seuls réellement utilisés en production) se
   * contentaient d'un `destroy()` paranoid : nom, prénom, email, téléphone,
   * photo et fonction restaient en base indéfiniment, en clair.
   *
   * Ne fait AUCUN contrôle d'autorisation : c'est la responsabilité de
   * l'appelant (rôle Admin, propriété de l'organisation, auto-suppression…).
   *
   * @param {import('sequelize').Model} utilisateur — instance déjà chargée
   * @returns {Promise<{ connexionLogsAnonymises: number }>}
   */
  static async pseudonymiserEtSupprimer(utilisateur, { transaction: externe } = {}) {
    const userId = utilisateur.id;
    const ancienEmail = utilisateur.email;

    // ── Tout ou rien ──────────────────────────────────────────────────────
    //
    // Sept ecritures s'enchainaient sans transaction. Un incident au milieu —
    // coupure de connexion, verrou, redemarrage — laissait un compte a MOITIE
    // anonymise : nom et courriel deja remplaces, mais jetons de session
    // toujours valides et appareils toujours enregistres.
    //
    // Autrement dit, un compte « supprime » qui continue d'agir et de recevoir
    // des notifications, tout en paraissant vivant a l'administration puisque
    // la suppression logique (etape 4) n'a jamais eu lieu. C'est une atteinte a
    // l'integrite ET au droit a l'effacement, pour une panne passagere.
    //
    // La transaction est acceptee de l'exterieur quand l'appelant en tient
    // deja une — la suppression d'une organisation supprime ses membres un a
    // un, et ces suppressions doivent tomber avec elle.
    const t = externe || (await sequelize.transaction());
    const proprietaire = !externe;

    try {
      return await AccountService._pseudonymiser(utilisateur, userId, ancienEmail, t, proprietaire);
    } catch (err) {
      if (proprietaire) await t.rollback();
      throw err;
    }
  }

  /** Le corps de la pseudonymisation, une fois la transaction etablie. */
  static async _pseudonymiser(utilisateur, userId, ancienEmail, t, proprietaire) {

    // 1) Table `utilisateur` — réécriture des colonnes directement identifiantes.
    //    L'email pseudonyme est déterministe (`deleted_<id>@deleted.local`) et le
    //    téléphone repasse à NULL : les deux colonnes portent un index unique
    //    COMPLET (non partiel), qu'une ligne soft-deleted continue d'occuper.
    //    Sans cette réécriture, une personne supprimée ne pouvait plus jamais
    //    être réinscrite : le contrôle applicatif (findOne, qui masque les
    //    soft-deleted) laissait passer, puis PostgreSQL rejetait en 23505 →
    //    409 « Cette ressource existe déjà », incompréhensible pour l'admin.
    //    mfa_secret / mfa_active sont vidés : secret d'authentification devenu
    //    sans objet, inutile de le conserver chiffré au repos.
    await utilisateur.update({
      nom: 'Supprimé',
      prenom: 'Compte',
      email: `deleted_${userId}@deleted.local`,
      telephone: null,
      photoProfil: null,
      fonction: null,
      statut: 'inactif',
      mfa_secret: null,
      mfa_active: false,
    }, { transaction: t });

    // 2) ConnexionLog — la table duplique l'email EN CLAIR dans sa propre colonne
    //    indexée à chaque tentative de connexion (réussie ou échouée), avec l'IP,
    //    le user-agent et l'horodatage. Cette colonne n'était jamais touchée :
    //    la pseudonymisation ci-dessus était donc RÉVERSIBLE par une simple
    //    jointure sur `utilisateur_id` resté inchangé.
    //
    //    DÉCISION : anonymisation en place plutôt qu'effacement pur. On conserve
    //    la trace strictement technique (horodatage, succès/échec, méthode) qui
    //    sert la sécurité du SI (détection de brute-force, volumétrie
    //    d'authentification — intérêt légitime, art. 6.1.f) et on vide tout ce
    //    qui identifie : email, ip, userAgent, et `donnees` (JSON libre pouvant
    //    contenir un motif d'échec avec l'email). Ce qui subsiste est un
    //    identifiant interne pointant vers un compte lui-même pseudonymisé.
    //    La disparition définitive de ces lignes est assurée par le job
    //    purgeDonneesPersonnelles (rétention bornée).
    //
    //    Le OR sur l'ancien email couvre les tentatives échouées journalisées
    //    sans `utilisateurId` (email inconnu / compte non résolu).
    const [connexionLogsAnonymises] = await ConnexionLog.update(
      { email: null, ip: null, userAgent: null, donnees: null },
      {
        where: { [Op.or]: [{ utilisateurId: userId }, { email: ancienEmail }] },
        transaction: t,
      }
    );

    // 3) Sessions, secrets et appareils — un compte supprimé ne doit plus pouvoir
    //    agir (les JWT/refresh en cours survivaient à la suppression), et un
    //    jeton push est lui-même un identifiant d'appareil rattaché à la personne.
    await RefreshToken.update(
      { revoked: true },
      { where: { utilisateurId: userId, revoked: false }, transaction: t }
    );
    await UserOtp.destroy({ where: { utilisateurId: userId }, transaction: t });
    await MfaChallenge.destroy({ where: { utilisateurId: userId }, transaction: t });
    await DeviceToken.destroy({ where: { utilisateurId: userId }, transaction: t });

    // 4) Suppression logique — la ligne reste pour l'intégrité référentielle
    //    (réserves, commentaires, historiques créés par cette personne), mais
    //    ne contient plus de donnée identifiante. Le job de purge l'efface
    //    définitivement (force: true) au bout de la durée de rétention.
    await utilisateur.destroy({ transaction: t });

    if (proprietaire) await t.commit();

    // Jamais d'email complet dans les logs (donnée personnelle).
    // APRES le commit : journaliser une suppression qui serait ensuite annulee
    // laisserait une trace fausse.
    logger.info('[rgpd] Compte pseudonymisé puis supprimé', { userId, connexionLogsAnonymises });

    return { connexionLogsAnonymises };
  }

  // -------------------- SUPPRESSION DE COMPTE (RGPD art. 17) --------------------
  static async deleteAccount(userId) {
    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { error: 'Utilisateur introuvable' };
    if (utilisateur.role === 'Admin') {
      return { error: 'Un compte Admin ne peut pas être supprimé via cette route.' };
    }

    await AccountService.pseudonymiserEtSupprimer(utilisateur);

    return { success: true, message: "Votre compte a été supprimé conformément à votre droit à l'effacement." };
  }

  // -------------------- HISTORIQUE DES CONNEXIONS (module 1) --------------------
  static async listConnexions(userId, { page = 1, limit = 20 } = {}) {
    const { rows, count } = await ConnexionLog.findAndCountAll({
      where: { utilisateurId: userId },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });
    return { success: true, connexions: rows, total: count };
  }

  // -------------------- SESSIONS ACTIVES (module 1) --------------------
  /** Liste les refresh tokens actifs (sessions ouvertes) de l'utilisateur. */
  static async listSessions(userId) {
    const sessions = await RefreshToken.findAll({
      where: { utilisateurId: userId, revoked: false, expiresAt: { [Op.gt]: new Date() } },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'createdAt', 'expiresAt'],
    });
    return { success: true, sessions };
  }

  /** Révoque une session précise (déconnexion à distance). */
  static async revokeSession(userId, sessionId) {
    const session = await RefreshToken.findOne({ where: { id: sessionId, utilisateurId: userId } });
    if (!session) return { success: false, message: 'Session introuvable' };
    await session.update({ revoked: true });
    return { success: true, message: 'Session révoquée' };
  }

  /**
   * Révoque toutes les sessions de l'utilisateur.
   *
   * Révoquer les refresh tokens ne coupait que le RENOUVELLEMENT : un jeton
   * d'accès volé restait valable jusqu'à son expiration (JWT_EXPIRES_IN),
   * alors que « déconnecter tous les appareils » est précisément le geste
   * d'un utilisateur qui soupçonne un vol. `token_version` périme à l'instant
   * tous les jetons d'accès déjà signés (voir auth.middleware.js) — l'appareil
   * courant compris, dont le refresh token vient de toute façon d'être révoqué.
   */
  static async revokeAllSessions(userId) {
    await RefreshToken.update(
      { revoked: true },
      { where: { utilisateurId: userId, revoked: false } }
    );
    await Utilisateur.increment('token_version', { where: { id: userId } });
    return { success: true, message: 'Toutes les sessions ont été révoquées' };
  }

  // -------------------- MFA — PROVISIONNEMENT (module 1) --------------------
  /** Génère le secret + QR code sans l'activer (activé ensuite par activerMfa). */
  static async provisionMfa(userId) {
    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    if (utilisateur.mfa_active) {
      return { success: false, message: 'Le MFA est déjà activé sur ce compte' };
    }
    const data = await MfaService.provision(utilisateur);
    return { success: true, ...data };
  }

  static async activerMfa(userId, { code, secret }) {
    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    const result = await MfaService.activer(utilisateur, { code, secret });
    if (!result.success) return result;
    return { success: true, message: result.message };
  }

  static async desactiverMfa(userId, { code }) {
    const utilisateur = await Utilisateur.findByPk(userId);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    const result = await MfaService.desactiver(utilisateur, { code });
    if (!result.success) return result;
    return { success: true, message: result.message };
  }

  // -------------------- EXPORT DES DONNÉES (RGPD art. 20) --------------------
  /**
   * Emballe une collection exportée : nombre de lignes, indicateur de troncature
   * et données. Le plafond est signalé DANS l'export pour que la personne sache
   * que sa copie est partielle (exigence de loyauté de l'information).
   */
  static _bloc(elements) {
    return {
      nombre: elements.length,
      tronque: elements.length >= EXPORT_MAX_PAR_CATEGORIE,
      elements,
    };
  }

  /**
   * Export de portabilité.
   *
   * Auparavant limité à 11 colonnes de la table `utilisateur` : l'export ne
   * couvrait AUCUNE des données produites par la personne (art. 20 vise les
   * données « fournies » ET générées par son activité). Sont désormais inclus :
   * historique de connexion, sessions, appareils, notifications, commentaires,
   * réserves créées/assignées, historique de réserves, médias (avec la
   * géolocalisation), signatures et annotations.
   *
   * Mémoire : chaque collection est plafonnée à EXPORT_MAX_PAR_CATEGORIE lignes
   * (les plus récentes) — la réponse est sérialisée d'un bloc en JSON par le
   * contrôleur, un compte actif produit des dizaines de milliers de lignes.
   */
  static async exportData(userId) {
    const utilisateur = await Utilisateur.findByPk(userId, {
      // mot_de_passe et mfa_secret ne sortent jamais : ce sont des secrets
      // d'authentification, pas des données personnelles portables.
      attributes: { exclude: ['mot_de_passe', 'mfa_secret'] },
    });
    if (!utilisateur) return { error: 'Utilisateur introuvable' };

    const options = (where, attributes, order = [['createdAt', 'DESC']]) => ({
      where, attributes, order, limit: EXPORT_MAX_PAR_CATEGORIE, raw: true,
    });

    const [
      connexions, sessions, appareils, notifications, commentaires,
      reservesCreees, reservesAssignees, historiqueReserves,
      medias, signatures, annotations,
    ] = await Promise.all([
      ConnexionLog.findAll(options({ utilisateurId: userId }, ['id', 'succes', 'type', 'ip', 'userAgent', 'createdAt'])),
      RefreshToken.findAll(options({ utilisateurId: userId }, ['id', 'revoked', 'expiresAt', 'createdAt'])),
      // Le jeton push brut est volontairement exclu : c'est une clé d'envoi
      // active, la restituer dans un fichier téléchargeable serait un risque
      // sans bénéfice de portabilité. Plateforme et dates suffisent.
      DeviceToken.findAll(options({ utilisateurId: userId }, ['id', 'platform', 'createdAt', 'updatedAt'])),
      Notification.findAll(options({ utilisateurId: userId }, ['id', 'type', 'titre', 'message', 'lu_a', 'donnees', 'createdAt'])),
      Commentaire.findAll(options({ utilisateurId: userId }, ['id', 'reserveId', 'message', 'createdAt', 'updatedAt'])),
      Reserve.findAll(options({ creePar: userId }, ['id', 'numero', 'chantierId', 'titre', 'description', 'severite', 'priorite', 'categorie', 'statut', 'date_limite', 'createdAt'])),
      Reserve.findAll(options({ assigneA: userId }, ['id', 'numero', 'chantierId', 'titre', 'statut', 'date_limite', 'createdAt'])),
      ReserveHistorique.findAll(options({ utilisateurId: userId }, ['id', 'reserveId', 'action', 'anciennes_valeurs', 'nouvelles_valeurs', 'createdAt'])),
      // Géolocalisation incluse : une photo horodatée et géolocalisée est une
      // donnée personnelle de son auteur, elle entre dans le périmètre art. 20.
      Media.findAll(options({ uploaderId: userId }, ['id', 'reserveId', 'inspectionId', 'type', 'url', 'latitude', 'longitude', 'pris_le', 'createdAt'])),
      // `donnees` (dataURL PNG du tracé) exclu : plusieurs centaines de Ko par
      // ligne, ferait exploser la réponse. Les métadonnées de signature suffisent.
      Signature.findAll(options({ utilisateurId: userId }, ['id', 'cibleType', 'cibleId', 'type', 'signe_le', 'createdAt'])),
      Annotation.findAll(options({ creePar: userId }, ['id', 'planId', 'type', 'x', 'y', 'latitude', 'longitude', 'donnees', 'createdAt'])),
    ]);

    return {
      success: true,
      exportedAt: new Date().toISOString(),
      limites: {
        maxParCategorie: EXPORT_MAX_PAR_CATEGORIE,
        note: `Chaque catégorie est limitée aux ${EXPORT_MAX_PAR_CATEGORIE} entrées les plus récentes. Le champ « tronque » indique si des données antérieures existent — contactez le responsable de traitement pour une copie exhaustive.`,
      },
      profil: {
        id: utilisateur.id,
        nom: utilisateur.nom,
        prenom: utilisateur.prenom,
        email: utilisateur.email,
        telephone: utilisateur.telephone,
        photoProfil: utilisateur.photoProfil,
        fonction: utilisateur.fonction,
        role: utilisateur.role,
        statut: utilisateur.statut,
        langue: utilisateur.langue,
        permissions: utilisateur.permissions,
        organisationId: utilisateur.organisationId,
        email_verifie: utilisateur.email_verifie,
        mfa_active: utilisateur.mfa_active,
        dernierConnexion: utilisateur.dernierConnexion,
        createdAt: utilisateur.createdAt,
        updatedAt: utilisateur.updatedAt,
      },
      securite: {
        connexions: AccountService._bloc(connexions),
        sessions: AccountService._bloc(sessions),
        appareils: AccountService._bloc(appareils),
      },
      activite: {
        reservesCreees: AccountService._bloc(reservesCreees),
        reservesAssignees: AccountService._bloc(reservesAssignees),
        historiqueReserves: AccountService._bloc(historiqueReserves),
        commentaires: AccountService._bloc(commentaires),
        annotations: AccountService._bloc(annotations),
        signatures: AccountService._bloc(signatures),
      },
      contenus: {
        medias: AccountService._bloc(medias),
      },
      communications: {
        notifications: AccountService._bloc(notifications),
      },
    };
  }
}

module.exports = AccountService;
