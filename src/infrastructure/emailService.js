'use strict';

const { Resend } = require('resend');
const logger = require('../utils/logger.js');

const FROM = process.env.MAIL_FROM || 'SuivieChantier <onboarding@resend.dev>';
const isProd = process.env.NODE_ENV === 'production';

// Client Resend initialisé paresseusement : l'app démarre même si la clé
// API n'est pas configurée (dev local). Les envois sont alors ignorés.
let resend = null;
let resendInitialise = false;

function getResend() {
  if (resendInitialise) return resend;
  resendInitialise = true;

  if (!process.env.RESEND_API_KEY) {
    logger.warn('[email] RESEND_API_KEY non définie — envois d’emails désactivés');
    return null;
  }
  resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

/**
 * Envoi générique — utilisé par tous les autres helpers.
 * @param {{ to: string, subject: string, html: string, attachments?: Array }} opts
 * @returns {Promise<object|null>}
 */
async function sendEmail({ to, subject, html, attachments = [] }) {
  const client = getResend();
  if (!client) return null; // clé API absente — best-effort, pas d'erreur

  const formattedAttachments = attachments.map((att) => ({
    filename: att.filename,
    content: att.content, // Buffer ou base64 string
  }));

  const payload = {
    from: FROM,
    to,
    subject,
    html,
    ...(formattedAttachments.length > 0 && { attachments: formattedAttachments }),
  };

  const { data, error } = await client.emails.send(payload);

  if (error) {
    logger.error('Resend — erreur envoi email :', error);
    throw new Error(error.message);
  }

  // Ne JAMAIS journaliser l'adresse email complète (PII) — uniquement le domaine
  const domaine = (Array.isArray(to) ? to[0] : to).split('@')[1] ?? '?';
  logger.info(`[resend] Email envoyé à *@${domaine} — ${subject}${isProd ? '' : ` (id: ${data?.id})`}`);

  return data;
}

/**
 * Email OTP de réinitialisation de mot de passe
 */
async function sendOtpEmail({ to, nom, otp }) {
  const otpTemplate = require('../templates/mail/otpPassword.template.js');
  return sendEmail({
    to,
    subject: 'Votre code de réinitialisation — SuivieChantier',
    html: otpTemplate({ nom, otp }),
  });
}

/**
 * Email de bienvenue à l'inscription
 */
async function sendWelcomeEmail({ to, nom, prenom }) {
  const welcomeTemplate = require('../templates/mail/welcome.template.js');
  return sendEmail({
    to,
    subject: 'Bienvenue sur SuivieChantier 🏗️',
    html: welcomeTemplate({ nom, prenom }),
  });
}

/**
 * Email de vérification d'adresse (lien signé, anti comptes usurpés — audit M5)
 */
async function sendVerificationEmail({ to, nom, prenom, token }) {
  const template = require('../templates/mail/verifyEmail.template.js');
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  // `/verification` (ancien chemin) ne correspond à AUCUNE route de l'admin
  // web — la seule route montée est `/verify-email` (voir
  // `admin/src/routes/AppRoutes.jsx`). Le lien envoyé par email tombait donc
  // systématiquement sur la page 404, sans aucun moyen pour l'utilisateur de
  // terminer la vérification (et donc de se connecter, REQUIRE_EMAIL_VERIFICATION
  // étant actif par défaut en production).
  const lien = `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: 'Vérifiez votre adresse email — SuivieChantier',
    html: template({ nom, prenom, lien }),
  });
}

module.exports = { sendEmail, sendOtpEmail, sendWelcomeEmail, sendVerificationEmail };
