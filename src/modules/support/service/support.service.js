'use strict';

const { Organisation } = require('../../../models/index.js');
const { sendEmail } = require('../../../infrastructure/emailService.js');
const escapeHtml = require('../../../utils/escapeHtml.js');
const logger = require('../../../utils/logger.js');

/**
 * Adresse qui reçoit les demandes de support.
 *
 * `SUPPORT_EMAIL` en priorité ; à défaut `ADMIN_EMAIL`, l'administrateur de la
 * plateforme, toujours renseigné en production (`config/security.js` refuse de
 * démarrer sans). L'adresse n'est JAMAIS renvoyée au client : seul le serveur
 * la connaît, et l'utilisateur reçoit la réponse du support dans sa boîte.
 */
function adresseSupport() {
  const adresse = (process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim();
  return adresse || null;
}

const INJOIGNABLE = 'Le support n’est pas joignable pour le moment. Réessayez plus tard.';

/** Ligne du tableau d'en-tête de l'email — omise quand la valeur est vide. */
const ligne = (libelle, valeur) => (valeur
  ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${escapeHtml(libelle)}</td>`
    + `<td style="padding:4px 0">${escapeHtml(valeur)}</td></tr>`
  : '');

class SupportService {
  /**
   * Transmet la demande d'un utilisateur au support, par email.
   *
   * `replyTo` porte l'adresse de l'utilisateur : le support lui répond d'un
   * simple « Répondre », sans recopier d'adresse.
   *
   * @param {object} utilisateur — `req.user`
   * @param {{ sujet: string, message: string, contexte?: { plateforme?: string, version?: string } }} demande
   * @returns {Promise<{ success: boolean, statut?: number, message: string }>}
   */
  static async envoyerMessage(utilisateur, { sujet, message, contexte = {} }) {
    const destinataire = adresseSupport();
    if (!destinataire) {
      logger.error('[support] Aucune adresse de support configurée (SUPPORT_EMAIL / ADMIN_EMAIL)');
      return { success: false, statut: 503, message: INJOIGNABLE };
    }

    const organisation = utilisateur.organisationId
      ? await Organisation.findByPk(utilisateur.organisationId, { attributes: ['id', 'nom'] })
      : null;

    const nomComplet = [utilisateur.prenom, utilisateur.nom].filter(Boolean).join(' ') || utilisateur.email;
    const application = [contexte?.plateforme, contexte?.version].filter(Boolean).join(' · ');
    // Le schéma interdit déjà les sauts de ligne ; on ne s'en remet pas à lui
    // seul pour un en-tête d'email.
    const objet = `[Support] ${String(sujet).replace(/[\r\n]+/g, ' ').trim()}`;

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#111827">
        <h2 style="font-size:16px;margin:0 0 12px">Nouvelle demande de support</h2>
        <table style="border-collapse:collapse;margin-bottom:16px">
          ${ligne('De', nomComplet)}
          ${ligne('Email', utilisateur.email)}
          ${ligne('Rôle', utilisateur.role)}
          ${ligne('Organisation', organisation?.nom)}
          ${ligne('Application', application)}
        </table>
        <p style="margin:0 0 6px;font-weight:bold">${escapeHtml(sujet)}</p>
        <div style="white-space:pre-wrap;border-left:3px solid #d1d5db;padding-left:12px">${escapeHtml(message)}</div>
        <p style="margin-top:16px;color:#6b7280;font-size:12px">Répondez directement à cet email pour écrire à l’utilisateur.</p>
      </div>`;

    try {
      const envoi = await sendEmail({ to: destinataire, replyTo: utilisateur.email, subject: objet, html });
      // `null` : aucun fournisseur d'envoi configuré. Rien n'est parti — le
      // dire vaut mieux qu'un faux « message envoyé ».
      if (!envoi) {
        logger.error('[support] Envoi impossible : fournisseur d’email non configuré (RESEND_API_KEY)');
        return { success: false, statut: 503, message: INJOIGNABLE };
      }
    } catch (err) {
      logger.error(`[support] Échec d’envoi du message de user=${utilisateur.id} : ${err.message}`);
      return {
        success: false,
        statut: 502,
        message: 'Votre message n’a pas pu être envoyé. Réessayez dans quelques minutes.',
      };
    }

    logger.info(`[support] Demande transmise — user=${utilisateur.id} org=${utilisateur.organisationId || '-'}`);
    return { success: true, message: 'Votre message a bien été envoyé. Le support vous répondra par email.' };
  }
}

module.exports = SupportService;
module.exports._interne = { adresseSupport };
