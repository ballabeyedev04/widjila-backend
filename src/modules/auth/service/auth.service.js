'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { Utilisateur, Organisation, RefreshToken, MfaChallenge } = require('../../../models/index.js');
const { jwtConfig, bcryptConfig } = require('../../../config/security.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { sendWelcomeEmail, sendVerificationEmail } = require('../../../infrastructure/emailService.js');
const { journaliserConnexion } = require('./connexionLog.service.js');
const MfaService = require('./mfa.service.js');

// Hash constant utilisé pour égaliser le temps de réponse login (anti timing-attack)
// Généré une seule fois avec bcrypt.hash(randomBytes, 12) — jamais comparé à un vrai mot de passe
const DUMMY_HASH = '$2b$12$LmKBP5z6RvWnAnsFOVK9Qeq7C2JKvPAzTq/xz7rJa2Y5m.JnHkTFO';

const MAX_REFRESH_TOKENS_PER_USER = 5;

// Verrouillage du compte après 5 échecs successifs pendant 15 minutes
const MAX_TENTATIVES = 5;
const BLOQUAGE_MINUTES = 15;

// MFA — nombre max de codes TOTP erronés par challenge avant re-login
const MAX_TENTATIVES_MFA = 5;
const MFA_CHALLENGE_MINUTES = 10;

// Exiger la vérification de l'email avant connexion ? (défaut : ON en production)
function _exigerVerificationEmail() {
  const flag = process.env.REQUIRE_EMAIL_VERIFICATION;
  if (flag === undefined || flag === '') return process.env.NODE_ENV === 'production';
  return flag === 'true' || flag === '1';
}

// ─── Helpers tokens ────────────────────────────────────────────────────────────

function _hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function _generateAccessToken(utilisateur) {
  return jwt.sign(
    { id: utilisateur.id, role: utilisateur.role, organisationId: utilisateur.organisationId || null },
    jwtConfig.secret,
    { expiresIn: jwtConfig.expiresIn }
  );
}

function _generateRefreshToken(utilisateur) {
  return jwt.sign(
    // jti unique : sans lui, deux connexions dans la même seconde produisent un
    // JWT identique (payload + iat identiques) → collision sur le hash unique
    // stocké en DB (refresh_tokens_token_hash) → 409.
    { id: utilisateur.id, type: 'refresh', jti: crypto.randomUUID() },
    jwtConfig.refreshSecret,
    { expiresIn: jwtConfig.refreshExpiresIn }
  );
}

/** Jeton éphémère (10 min) émis quand le MFA est requis, complété ensuite. */
function _generateMfaToken(utilisateur) {
  return jwt.sign(
    { id: utilisateur.id, type: 'mfa', jti: crypto.randomUUID() },
    jwtConfig.secret,
    { expiresIn: `${MFA_CHALLENGE_MINUTES}m` }
  );
}

/**
 * Crée un challenge MFA (jeton + enregistrement DB du hash) pour un login.
 * Un seul challenge actif par utilisateur : générer un nouveau challenge
 * invalide le précédent.
 */
async function _creerChallengeMfa(utilisateur) {
  const token = _generateMfaToken(utilisateur);
  await MfaChallenge.destroy({ where: { utilisateurId: utilisateur.id } });
  await MfaChallenge.create({
    utilisateurId: utilisateur.id,
    tokenHash: _hashToken(token),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60 * 1000),
  });
  return token;
}

/** Stocke un refresh token en DB (hash uniquement), purge les expirés, limite à 5 actifs. */
async function _storeRefreshToken(utilisateurId, refreshToken, transaction) {
  const decoded = jwt.decode(refreshToken);
  const expiresAt = new Date(decoded.exp * 1000);

  // Purge des tokens expirés en premier (libère des slots)
  await RefreshToken.destroy({
    where: { utilisateurId, expiresAt: { [Op.lt]: new Date() } },
    transaction,
  });

  // Si la limite est atteinte, révoquer le plus ancien token valide
  const activeCount = await RefreshToken.count({ where: { utilisateurId }, transaction });
  if (activeCount >= MAX_REFRESH_TOKENS_PER_USER) {
    const oldest = await RefreshToken.findOne({
      where: { utilisateurId },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    if (oldest) await oldest.destroy({ transaction });
  }

  await RefreshToken.create(
    { tokenHash: _hashToken(refreshToken), utilisateurId, expiresAt },
    { transaction }
  );
}

// ─── AuthService ───────────────────────────────────────────────────────────────

class AuthService {

  /**
   * Émet une paire access + refresh token et enregistre la connexion.
   * Utilisé par login et vérification MFA.
   */
  static async emettreTokens(utilisateur) {
    const accessToken  = _generateAccessToken(utilisateur);
    const refreshToken = _generateRefreshToken(utilisateur);

    const t = await sequelize.transaction();
    try {
      await _storeRefreshToken(utilisateur.id, refreshToken, t);
      await utilisateur.update({ dernierConnexion: new Date() }, { transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { accessToken, refreshToken };
  }

  // -------------------- INSCRIPTION --------------------
  // Inscription SaaS : crée l'organisation ET son premier utilisateur
  // (le chef de projet / administrateur de l'organisation).
  static async register(body) {
    const {
      nom, prenom, email, mot_de_passe, telephone, fonction,
      organisationNom, raison_sociale, siret, rccm, ninea,
      organisationTelephone, organisationEmail, organisationAdresse,
      organisationVille, organisationPays,
    } = body;

    // L'inscription crée TOUJOURS une organisation (organisationNom est requis
    // ci-dessous) : son premier utilisateur en est donc l'administrateur.
    // Il reçoit 'ChefProjet', seul rôle du groupe GESTION accessible hors
    // super-admin — sans quoi il obtiendrait un 403 sur la gestion des membres,
    // des équipes et de sa propre organisation.
    // Le rôle 'Admin' reste réservé au super-admin plateforme.
    // Les autres rôles (ConducteurTravaux, BureauControle, MaitreOuvrage,
    // MaitreOeuvre, Entreprise, Client) sont attribués ensuite par cet
    // administrateur depuis l'écran Membres.
    const role = 'ChefProjet';

    if (!organisationNom) {
      return { success: false, message: "Le nom de l'organisation est obligatoire à l'inscription" };
    }

    const t = await sequelize.transaction();

    try {
      const emailClean = email.trim().toLowerCase();

      const exist = await Utilisateur.findOne({ where: { email: emailClean }, transaction: t });
      if (exist) { await t.rollback(); return { success: false, message: 'Cet email est déjà utilisé' }; }

      if (telephone) {
        const telExist = await Utilisateur.findOne({ where: { telephone }, transaction: t });
        if (telExist) { await t.rollback(); return { success: false, message: 'Ce numéro de téléphone est déjà utilisé' }; }
      }

      if (siret) {
        const orgExist = await Organisation.findOne({ where: { siret }, transaction: t });
        if (orgExist) { await t.rollback(); return { success: false, message: 'Ce SIRET est déjà enregistré' }; }
      }

      const hashedPassword = await bcrypt.hash(mot_de_passe, bcryptConfig.saltRounds);

      // 1. Créer l'organisation (avec trial de 7 jours)
      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const organisation = await Organisation.create({
        nom: organisationNom,
        raison_sociale: raison_sociale || organisationNom,
        siret: siret || null,
        rccm: rccm || null,
        ninea: ninea || null,
        telephone: organisationTelephone || null,
        email: (organisationEmail || '').toLowerCase() || null,
        adresse: organisationAdresse || null,
        ville: organisationVille || null,
        pays: organisationPays || 'France',
        trial_ends_at: trialEndsAt,
      }, { transaction: t });

      // 2. Créer le premier utilisateur — admin de son organisation
      // (permissions ['all'] = accès total sur les ressources de l'org)
      const utilisateur = await Utilisateur.create({
        organisationId: organisation.id,
        nom,
        prenom,
        email: emailClean,
        mot_de_passe: hashedPassword,
        telephone: telephone || null,
        fonction: fonction || null,
        role,
        permissions: ['all'],
        statut: 'actif',
      }, { transaction: t });

      await t.commit();

      // Emails best-effort (ne bloquent pas l'inscription) : bienvenue + lien
      // de vérification d'email (anti création de comptes usurpés — audit M5).
      sendWelcomeEmail({ to: emailClean, nom, prenom }).catch((err) =>
        logger.warn('[email] Bienvenue non envoyé :', err.message)
      );
      const verifToken = AuthService._genererTokenVerificationEmail(utilisateur);
      sendVerificationEmail({ to: emailClean, nom, prenom, token: verifToken }).catch((err) =>
        logger.warn('[email] Vérification email non envoyée :', err.message)
      );

      return { success: true, message: 'Inscription réussie', utilisateur, organisation };

    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  // -------------------- VÉRIFICATION EMAIL (module sécurité / audit M5) --------------------
  /** Jeton signé (24 h) portant l'identité de l'utilisateur à vérifier. */
  static _genererTokenVerificationEmail(utilisateur) {
    return jwt.sign(
      { id: utilisateur.id, type: 'email_verif' },
      jwtConfig.resetSecret,
      { expiresIn: '24h' }
    );
  }

  /** Vérifie le lien d'email : marque le compte comme vérifié (usage unique). */
  static async verifierEmail(token) {
    let decoded;
    try {
      decoded = jwt.verify(token, jwtConfig.resetSecret);
    } catch (err) {
      return { success: false, message: 'Lien de vérification invalide ou expiré.' };
    }
    if (decoded.type !== 'email_verif') {
      return { success: false, message: 'Lien de vérification invalide.' };
    }

    const utilisateur = await Utilisateur.findByPk(decoded.id);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable.' };

    if (!utilisateur.email_verifie) {
      await utilisateur.update({ email_verifie: true });
      logger.info(`[email] Compte vérifié : ${utilisateur.id}`);
    }
    return { success: true, message: 'Adresse email vérifiée avec succès.', utilisateur };
  }

  // -------------------- CONNEXION --------------------
  /**
   * Connexion par mot de passe avec :
   *   - verrouillage du compte après 5 échecs (15 min) ;
   *   - journal d'audit des connexions (succès / échecs) ;
   *   - challenge MFA si le compte l'a activé (mfaRequise + mfaToken).
   */
  static async login({ identifiant, mot_de_passe }, meta = {}) {
    // Motif ANCRÉ et à quantificateurs bornés. La version non ancrée
    // /\S+@\S+\.\S+/ avait un coût quadratique par retour arrière : 80 000
    // caractères gelaient le processus 32 secondes. L'ancrage ^…$ supprime les
    // points de départ multiples, et les bornes plafonnent le travail.
    const isEmail = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/.test(identifiant);
    const utilisateur = await Utilisateur.findOne({
      where: isEmail ? { email: identifiant.toLowerCase() } : { telephone: identifiant },
    });

    if (!utilisateur) {
      // Égaliser le temps de réponse pour éviter l'énumération par timing
      await bcrypt.compare(mot_de_passe, DUMMY_HASH);
      await journaliserConnexion({
        email: identifiant.toLowerCase(), succes: false, type: 'password', meta,
        donnees: { motif: 'compte_inexistant' },
      });
      return { success: false, message: 'Identifiant ou mot de passe incorrect' };
    }

    // Compte verrouillé (anti force-brute)
    if (utilisateur.compte_bloque_jusqua && new Date(utilisateur.compte_bloque_jusqua) > new Date()) {
      const fin = new Date(utilisateur.compte_bloque_jusqua);
      return {
        success: false,
        message: `Compte temporairement bloqué après plusieurs échecs. Réessayez après ${fin.toLocaleTimeString('fr-FR')}.`,
      };
    }

    // 'en_attente_validation' n'est pas bloquant — seul 'inactif' l'est.
    if (utilisateur.statut === 'inactif') {
      return { success: false, message: 'Votre compte est inactif. Veuillez contacter le support.' };
    }

    const valid = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe);
    if (!valid) {
      // Comptabiliser l'échec et verrouiller au bout du seuil
      const tentatives = (utilisateur.tentatives_connexion || 0) + 1;
      const updates = { tentatives_connexion: tentatives };
      if (tentatives >= MAX_TENTATIVES) {
        updates.compte_bloque_jusqua = new Date(Date.now() + BLOQUAGE_MINUTES * 60 * 1000);
        updates.tentatives_connexion = 0;
      }
      await utilisateur.update(updates);
      await journaliserConnexion({
        utilisateurId: utilisateur.id, email: utilisateur.email, succes: false, type: 'password', meta,
        donnees: { motif: 'mot_de_passe_incorrect', tentatives },
      });
      return { success: false, message: 'Identifiant ou mot de passe incorrect' };
    }

    // Mot de passe valide → réinitialiser le compteur d'échecs
    await utilisateur.update({ tentatives_connexion: 0, compte_bloque_jusqua: null });

    // Vérification d'email requise avant la première connexion ? (audit M5)
    if (_exigerVerificationEmail() && !utilisateur.email_verifie) {
      return {
        success: false,
        message: 'Veuillez vérifier votre adresse email avant de vous connecter. Vérifiez votre boîte de réception.',
      };
    }

    // MFA activé → émettre un challenge TOTP avant les tokens (jeton à usage unique)
    if (utilisateur.mfa_active) {
      await journaliserConnexion({
        utilisateurId: utilisateur.id, email: utilisateur.email, succes: true, type: 'password', meta,
        donnees: { mfa: 'en_attente' },
      });
      return {
        success: true,
        mfaRequise: true,
        mfaToken: await _creerChallengeMfa(utilisateur),
        utilisateur,
      };
    }

    const { accessToken, refreshToken } = await AuthService.emettreTokens(utilisateur);
    await journaliserConnexion({
      utilisateurId: utilisateur.id, email: utilisateur.email, succes: true, type: 'password', meta,
    });

    return { success: true, token: accessToken, refreshToken, utilisateur };
  }

  // -------------------- VÉRIFICATION MFA --------------------
  /**
   * Termine la connexion après validation d'un code TOTP.
   * Sécurité (audit H3) : le jeton MFA est à USAGE UNIQUE (challenge supprimé
   * dès son utilisation) et un compteur limite les codes TOTP erronés par
   * challenge (anti brute-force par rotation d'IP).
   */
  static async verifierMfa({ mfaToken, code }, meta = {}) {
    if (!mfaToken) return { success: false, message: 'Session MFA expirée. Recommencez la connexion.' };
    const tokenHash = _hashToken(mfaToken);

    // Le challenge doit exister en DB (le hash du jeton est stocké au login)
    const challenge = await MfaChallenge.findOne({ where: { tokenHash } });
    if (!challenge) return { success: false, message: 'Session MFA expirée. Recommencez la connexion.' };

    let decoded;
    try {
      decoded = jwt.verify(mfaToken, jwtConfig.secret);
    } catch (err) {
      await challenge.destroy();
      return { success: false, message: 'Session MFA expirée. Recommencez la connexion.' };
    }
    if (decoded.type !== 'mfa') {
      await challenge.destroy();
      return { success: false, message: 'Jeton MFA invalide' };
    }

    if (challenge.expiresAt < new Date()) {
      await challenge.destroy();
      return { success: false, message: 'Session MFA expirée. Recommencez la connexion.' };
    }

    const utilisateur = await Utilisateur.findByPk(decoded.id);
    if (!utilisateur) {
      await challenge.destroy();
      return { success: false, message: 'Utilisateur introuvable' };
    }
    if (!utilisateur.mfa_active || !utilisateur.mfa_secret) {
      await challenge.destroy();
      return { success: false, message: 'MFA non activé sur ce compte' };
    }

    if (!MfaService.verify(utilisateur.mfa_secret, code)) {
      const tentatives = (challenge.tentatives || 0) + 1;
      if (tentatives >= MAX_TENTATIVES_MFA) {
        await challenge.destroy();
        await journaliserConnexion({
          utilisateurId: utilisateur.id, email: utilisateur.email, succes: false, type: 'mfa', meta,
          donnees: { motif: 'code_invalide_max_tentatives' },
        });
        return { success: false, message: 'Trop de tentatives. Recommencez la connexion.' };
      }
      await challenge.update({ tentatives });
      await journaliserConnexion({
        utilisateurId: utilisateur.id, email: utilisateur.email, succes: false, type: 'mfa', meta,
        donnees: { motif: 'code_invalide', tentatives },
      });
      return { success: false, message: 'Code de vérification invalide' };
    }

    // Code valide → challenge consommé (usage unique)
    await challenge.destroy();

    const { accessToken, refreshToken } = await AuthService.emettreTokens(utilisateur);
    await journaliserConnexion({
      utilisateurId: utilisateur.id, email: utilisateur.email, succes: true, type: 'mfa', meta,
    });

    return { success: true, token: accessToken, refreshToken, utilisateur };
  }

  // -------------------- REFRESH TOKEN --------------------
  /**
   * Émet une nouvelle paire access + refresh token (rotation).
   * L'ancien refresh token est révoqué immédiatement après usage.
   */
  static async refresh({ refreshToken }) {
    if (!refreshToken) return { success: false, message: 'Refresh token manquant' };

    // 1. Vérifier la signature JWT
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, jwtConfig.refreshSecret);
    } catch (err) {
      return { success: false, message: 'Refresh token invalide ou expiré' };
    }

    if (decoded.type !== 'refresh') {
      return { success: false, message: 'Type de token invalide' };
    }

    // 2. Vérifier la présence en DB et l'absence de révocation
    const tokenHash = _hashToken(refreshToken);
    const storedToken = await RefreshToken.findOne({ where: { tokenHash } });

    if (!storedToken) return { success: false, message: 'Refresh token inconnu' };
    if (storedToken.revoked) return { success: false, message: 'Refresh token révoqué' };
    if (storedToken.expiresAt < new Date()) return { success: false, message: 'Refresh token expiré' };

    // 3. Charger l'utilisateur
    const utilisateur = await Utilisateur.findByPk(decoded.id);
    if (!utilisateur) return { success: false, message: 'Utilisateur introuvable' };
    if (utilisateur.statut === 'inactif') return { success: false, message: 'Compte inactif' };

    // 4. Rotation : révoquer l'ancien token, émettre un nouveau couple
    const t = await sequelize.transaction();
    try {
      await storedToken.update({ revoked: true }, { transaction: t });

      const newAccessToken  = _generateAccessToken(utilisateur);
      const newRefreshToken = _generateRefreshToken(utilisateur);
      await _storeRefreshToken(utilisateur.id, newRefreshToken, t);

      await t.commit();

      return { success: true, token: newAccessToken, refreshToken: newRefreshToken };
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  // -------------------- DÉCONNEXION --------------------
  /** Révoque le refresh token fourni (déconnexion propre). */
  static async logout({ refreshToken }) {
    if (!refreshToken) return { success: true }; // Rien à révoquer

    const tokenHash = _hashToken(refreshToken);
    await RefreshToken.update(
      { revoked: true },
      { where: { tokenHash, revoked: false } }
    );

    return { success: true };
  }
}

module.exports = AuthService;
