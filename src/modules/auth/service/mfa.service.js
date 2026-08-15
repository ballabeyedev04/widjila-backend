'use strict';

const { generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');

// Tolérance d'une fenêtre de 30 s de part et d'autre (dérive d'horloge)
const EPOCH_TOLERANCE_SECONDS = 30;

/**
 * MFA — authentification à deux facteurs par TOTP (module 1 / cahier des
 * charges § Authentification à deux facteurs). Compatible Google Authenticator,
 * Microsoft Authenticator, Authy… (otplib v13, API fonctionnelle).
 */
class MfaService {

  /**
   * Génère un secret TOTP + URL otpauth + QR code pour provisionner l'appli.
   * Le secret n'est PAS encore persisté — il sera activé par activer().
   */
  static async provision(utilisateur) {
    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: 'SuivieChantier', label: utilisateur.email, secret });
    const qr = await QRCode.toDataURL(otpauthUrl);
    return { secret, otpauthUrl, qr };
  }

  /**
   * Active le MFA : vérifie un premier code produit par l'appli avec le
   * secret fourni (preuve que l'utilisateur détient bien son téléphone).
   */
  static async activer(utilisateur, { code, secret }) {
    if (!secret) return { success: false, message: 'Secret de configuration manquant' };
    if (!MfaService.verify(secret, code)) {
      return { success: false, message: 'Code de vérification invalide' };
    }
    await utilisateur.update({ mfa_secret: secret, mfa_active: true });
    return { success: true, message: 'Authentification à deux facteurs activée' };
  }

  /** Désactive le MFA après vérification d'un code valide. */
  static async desactiver(utilisateur, { code }) {
    if (!utilisateur.mfa_secret) {
      return { success: false, message: "Le MFA n'est pas activé sur ce compte" };
    }
    if (!MfaService.verify(utilisateur.mfa_secret, code)) {
      return { success: false, message: 'Code de vérification invalide' };
    }
    await utilisateur.update({ mfa_secret: null, mfa_active: false });
    return { success: true, message: 'Authentification à deux facteurs désactivée' };
  }

  /** Vérifie un code TOTP contre le secret de l'utilisateur. */
  static verify(secret, code) {
    try {
      return Boolean(verifySync({ secret, token: String(code).trim(), epochTolerance: EPOCH_TOLERANCE_SECONDS }).valid);
    } catch (err) {
      return false;
    }
  }
}

module.exports = MfaService;
