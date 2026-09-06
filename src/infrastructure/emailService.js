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
 * Email — demande d'inscription validée par le super-admin.
 * Le lien pointe vers l'écran de connexion de l'admin web : le compte est
 * actif, l'utilisateur n'a plus qu'à s'y rendre.
 */
async function sendInscriptionValideeEmail({ to, nom, prenom, organisationNom }) {
  const template = require('../templates/mail/inscriptionValidee.template.js');
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return sendEmail({
    to,
    subject: 'Votre compte SuivieChantier est activé',
    html: template({ nom, prenom, organisationNom, lien: `${frontendUrl}/login` }),
  });
}

/**
 * Email — demande d'inscription rejetée. `motif` est saisi par l'admin et
 * constitue la seule explication reçue par le demandeur : il est obligatoire
 * en amont (voir demandeInscription.validation.js).
 */
async function sendInscriptionRejeteeEmail({ to, nom, prenom, motif, organisationNom }) {
  const template = require('../templates/mail/inscriptionRejetee.template.js');
  return sendEmail({
    to,
    subject: "Suite à votre demande d'inscription — SuivieChantier",
    html: template({ nom, prenom, motif, organisationNom }),
  });
}

/**
 * Emails du circuit de validation des chantiers.
 *
 * Les trois messages partagent un gabarit — voir
 * `templates/mail/chantierValidation.template.js`.
 *
 * `to` accepte une liste : la demande part à TOUS ceux qui peuvent la
 * trancher, pas au premier trouvé. Un seul destinataire en congé suffirait
 * sinon à bloquer une demande indéfiniment.
 */
async function sendChantierValidationEmail({
  to, variante, destinataire, chantierNom, chantierCode, demandeurNom, motif, chantierId,
  organisationNom,
}) {
  const template = require('../templates/mail/chantierValidation.template.js');
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

  const SUJETS = {
    demande: `Nouvelle demande de chantier — ${chantierNom}`,
    validee: `Votre chantier « ${chantierNom} » est validé`,
    rejetee: `Suite à votre demande de chantier — ${chantierNom}`,
  };

  // Le lien dépend de la variante, et c'est nécessaire.
  //
  // `/chantiers/:id` ne mène nulle part tant que la demande n'est pas
  // validée : le serveur écarte les demandes de la liste des chantiers. Le
  // valideur qui suivait le bouton « Examiner la demande » arrivait donc sur
  // un écran vide, et devait retrouver la demande à la main.
  //
  // Un refus renvoie au même écran : c'est là que l'entreprise lit le motif et
  // reprend sa demande.
  const lien = chantierId
    ? (variante === 'validee'
        ? `${frontendUrl}/chantiers/${chantierId}`
        : `${frontendUrl}/chantiers/demandes/${chantierId}`)
    : undefined;

  return sendEmail({
    to,
    subject: SUJETS[variante] || SUJETS.demande,
    html: template({
      variante,
      destinataire,
      chantierNom,
      chantierCode,
      demandeurNom,
      organisationNom,
      motif,
      lien,
    }),
  });
}

/**
 * Email — un membre vient d'être ajouté à une organisation, avec ses
 * identifiants de connexion.
 *
 * Remplace l'affichage du mot de passe temporaire dans une fenêtre côté
 * client : celui-ci n'est renvoyé qu'UNE fois par le serveur, et il restait
 * ensuite à le transmettre à l'intéressé par un moyen quelconque. Ici il part
 * directement à la bonne adresse.
 *
 * `motDePasse` est nul quand le créateur en a choisi un lui-même : le serveur
 * ne le connaît alors qu'en empreinte, et le message renvoie vers lui.
 */
async function sendNouveauMembreEmail({
  to, prenom, nom, auteurNom, organisationNom, role, motDePasse,
}) {
  const template = require('../templates/mail/nouveauMembre.template.js');
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return sendEmail({
    to,
    subject: `Vous avez été ajouté à ${organisationNom} — SuivieChantier`,
    html: template({
      prenom,
      nom,
      auteurNom,
      organisationNom,
      role,
      email: to,
      motDePasse,
      lien: `${frontendUrl}/login`,
    }),
  });
}

/**
 * Email INTERNE — une demande de suppression de compte a été déposée sur la
 * page publique.
 *
 * Le destinataire est l'équipe, pas le demandeur : `DELETION_REQUEST_EMAIL`
 * permet de le changer sans redéploiement, avec un repli sur l'adresse de
 * l'auteur du module pour que la notification parte même si la variable
 * d'environnement a été oubliée — une demande RGPD silencieusement perdue
 * coûte plus cher qu'un email envoyé à la mauvaise boîte.
 */
async function sendDemandeSuppressionEmail({ email, objet, date, ip }) {
  const template = require('../templates/mail/demandeSuppression.template.js');
  const destinataire = process.env.DELETION_REQUEST_EMAIL || 'ballabeye.dev04@gmail.com';
  return sendEmail({
    to: destinataire,
    subject: `Demande de suppression de compte — ${email}`,
    html: template({ email, objet, date, ip }),
  });
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendWelcomeEmail,
  sendInscriptionValideeEmail,
  sendInscriptionRejeteeEmail,
  sendChantierValidationEmail,
  sendNouveauMembreEmail,
  sendDemandeSuppressionEmail,
};
