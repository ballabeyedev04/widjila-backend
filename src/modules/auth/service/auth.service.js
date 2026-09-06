'use strict';

const crypto = require('crypto');
const hashToken = require('../../../utils/hashToken.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { Utilisateur, Organisation, RefreshToken, MfaChallenge } = require('../../../models/index.js');
const { jwtConfig, bcryptConfig } = require('../../../config/security.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { journaliserConnexion } = require('./connexionLog.service.js');
const MfaService = require('./mfa.service.js');
const { TOUS_CHAMPS } = require('../../../config/pays.js');

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
// ─── Helpers tokens ────────────────────────────────────────────────────────────

// Empreinte des refresh tokens — définition UNIQUE partagée avec
// account.service (voir utils/hashToken.js).
const _hashToken = hashToken;

function _generateAccessToken(utilisateur) {
  return jwt.sign(
    {
      id: utilisateur.id,
      role: utilisateur.role,
      organisationId: utilisateur.organisationId || null,
      // Version des tokens au moment de la signature — `auth.middleware` la
      // compare à la valeur en base et rejette le token si elle a bougé
      // (changement ou réinitialisation de mot de passe). C'est ce qui rend
      // un token d'accès révocable malgré son absence d'état.
      tv: utilisateur.token_version || 0,
    },
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
      organisationNom, raison_sociale,
      organisationTelephone, organisationEmail, organisationAdresse,
      organisationVille, organisationPays,
    } = body;

    // L'inscription crée TOUJOURS une organisation (organisationNom est requis
    // ci-dessous) : son premier utilisateur en est donc l'administrateur.
    //
    // Il reçoit 'Entreprise' — le rôle de celui qui s'inscrit spontanément sur
    // la plateforme. Ce rôle n'appartient PAS au groupe GESTION : tel quel, le
    // compte ne peut pas administrer sa propre organisation. C'est voulu : le
    // rôle définitif est arbitré par le super-admin au moment de valider la
    // demande (voir demandeInscription.service.js), qui peut le laisser à
    // 'Entreprise' ou le promouvoir en 'ChefProjet'.
    // Le rôle 'Admin' reste réservé au super-admin plateforme.
    const role = 'Entreprise';

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

      if (body.siret) {
        const orgExist = await Organisation.findOne({ where: { siret: body.siret }, transaction: t });
        if (orgExist) { await t.rollback(); return { success: false, message: 'Ce SIRET est déjà enregistré' }; }
      }

      const hashedPassword = await bcrypt.hash(mot_de_passe, bcryptConfig.saltRounds);

      // 1. Créer l'organisation — SANS démarrer l'essai gratuit
      const organisation = await Organisation.create({
        nom: organisationNom,
        raison_sociale: raison_sociale || organisationNom,

        // Identifiants d'entreprise, repris tels que le schéma les a validés.
        //
        // Énumérés depuis `config/pays.js` plutôt qu'un par un : les trois
        // qui manquaient (NIF, NCC, IDU) étaient tout simplement absents de
        // cette liste, donc silencieusement jetés à l'inscription. Ajouter un
        // pays ne demandera plus de repasser ici.
        ...Object.fromEntries(
          TOUS_CHAMPS.map((cle) => [cle, body[cle] || null])
        ),

        telephone: organisationTelephone || null,
        email: (organisationEmail || '').toLowerCase() || null,
        adresse: organisationAdresse || null,
        ville: organisationVille || null,
        // Code ISO, et non le libellé : c'est lui qui commande l'affichage
        // des champs d'identification côté client.
        pays: organisationPays || 'FR',

        // L'essai ne démarre PAS ici, et le NULL est explicite (il écrase le
        // défaut du modèle, qui protège les organisations créées par d'autres
        // chemins). Le compte qui suit naît « en_attente_validation » : tant
        // que le super-admin n'a pas tranché, la connexion est refusée et
        // l'entreprise ne peut rien essayer. Faire courir l'essai pendant ce
        // délai revenait à le lui facturer sans qu'elle y ait accès — et une
        // validation tardive la faisait arriver sur « essai terminé » à sa
        // toute première connexion.
        //
        // Le compte à rebours part à la validation, dans
        // essai.service.js#demarrerEssai. Voir config/essai.js.
        trial_ends_at: null,
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
        // L'inscription publique ne donne pas un compte utilisable : elle
        // dépose une DEMANDE. Statut bloquant jusqu'à la décision du
        // super-admin (voir login() et checkActiveUser.middleware.js).
        statut: 'en_attente_validation',
        // Plus de lien de vérification à cliquer : c'est le super-admin qui
        // valide chaque demande, et il joue le rôle d'acteur de confiance —
        // exactement comme pour un membre invité (organisation.service.js) ou
        // un compte créé depuis la plateforme (gestionUtilisateur.service.js),
        // qui posent déjà `true` pour ce motif.
        email_verifie: true,
      }, { transaction: t });

      await t.commit();

      // Aucun email n'est envoyé ici, volontairement.
      //
      // Le lien de vérification a été retiré : il ajoutait une étape avant
      // une seconde étape (la validation du super-admin) qui, elle, décide
      // réellement de l'ouverture du compte. Le demandeur restait bloqué sans
      // savoir laquelle des deux il attendait.
      //
      // L'email « Bienvenue » n'est pas envoyé non plus : il annoncerait un
      // compte prêt alors que la connexion est bloquée. C'est
      // `sendInscriptionValideeEmail` qui prévient, au bon moment.

      return {
        success: true,
        message: "Demande d'inscription enregistrée. Votre compte sera actif dès qu'un administrateur l'aura validé — vous recevrez un email.",
        enAttenteValidation: true,
        utilisateur,
        organisation,
      };

    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  // -------------------- VÉRIFICATION EMAIL (module sécurité / audit M5) --------------------
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

    // Demande d'inscription non encore tranchée par le super-admin.
    // Ce contrôle est volontairement placé APRÈS la vérification du mot de
    // passe : le placer avant révélerait l'état d'un compte à quiconque
    // connaît l'adresse email, sans avoir à prouver quoi que ce soit
    // (énumération). Même parti pris que le contrôle d'email vérifié ci-dessous.
    if (utilisateur.statut === 'en_attente_validation') {
      return {
        success: false,
        message: "Votre demande d'inscription est en cours d'examen. Vous recevrez un email dès qu'un administrateur l'aura validée.",
        code: 'COMPTE_EN_ATTENTE',
      };
    }

    if (utilisateur.statut === 'rejete') {
      return {
        success: false,
        // Le motif a déjà été envoyé par email ; le rappeler ici évite à
        // l'utilisateur d'aller le rechercher pour comprendre le blocage.
        message: utilisateur.motif_rejet
          ? `Votre demande d'inscription a été refusée. Motif : ${utilisateur.motif_rejet}`
          : "Votre demande d'inscription a été refusée.",
        code: 'COMPTE_REJETE',
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
    // Tout statut autre qu'« actif » coupe la session : sans ce contrôle, un
    // compte rejeté ou remis en attente garderait un accès valide jusqu'à
    // l'expiration naturelle de son refresh token.
    if (utilisateur.statut !== 'actif') {
      return { success: false, message: 'Compte non actif' };
    }

    // 4. Rotation : révoquer l'ancien token, émettre un nouveau couple
    const t = await sequelize.transaction();
    try {
      // Révocation CONDITIONNELLE, et non `storedToken.update(...)`.
      //
      // Entre la lecture de l'étape 2 et cette écriture, rien ne verrouillait
      // la ligne. Deux rafraîchissements simultanés portant le même jeton
      // passaient donc tous les deux le contrôle `revoked`, et repartaient
      // chacun avec un couple valide : deux familles de jetons vivantes issues
      // d'un seul, ce qui vide la rotation de son intérêt — on ne peut plus
      // distinguer un client légitime d'un jeton volé rejoué.
      //
      // `WHERE revoked = false` fait de cette mise à jour l'arbitre : la
      // première transaction pose le verrou de ligne, la seconde attend, puis
      // ne touche plus rien. C'est exactement le motif déjà employé par
      // `logout` ci-dessous.
      //
      // Le mobile sérialise déjà ses propres rafraîchissements (file d'attente
      // dans `dio_client_factory.dart`), mais deux appareils — ou l'espace
      // d'administration — partagent parfois une session : la garantie doit
      // venir de la base, pas de la discipline du client.
      const [revoques] = await RefreshToken.update(
        { revoked: true },
        { where: { tokenHash, revoked: false }, transaction: t }
      );
      if (revoques === 0) {
        // Quelqu'un d'autre a consommé ce jeton entre-temps. Le perdant
        // repart en session expirée plutôt qu'avec un second couple valide.
        await t.rollback();
        return { success: false, message: 'Refresh token révoqué' };
      }

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

// Génération d'un token d'accès — exposée pour `account.service`, qui doit en
// délivrer un neuf à l'appareil courant après avoir incrémenté
// `token_version` (sans quoi il se déconnecterait lui-même en sécurisant son
// compte). Définition UNIQUE : un second `jwt.sign` ailleurs finirait par
// oublier `tv` et rouvrirait silencieusement la faille.
module.exports.genererAccessToken = _generateAccessToken;
