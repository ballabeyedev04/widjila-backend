'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Template email — NOTIFICATION INTERNE : une demande de suppression de compte
 * vient d'être déposée sur la page publique.
 *
 * Destiné à l'équipe, pas au demandeur. L'objet est saisi librement par un
 * visiteur NON AUTHENTIFIÉ : il est échappé sans exception, et rendu avec
 * `white-space:pre-line` pour conserver ses retours à la ligne.
 *
 * Le délai de 30 jours est rappelé dans le corps parce que c'est le compteur
 * qui court à partir de la réception (RGPD art. 12.3) — l'information est
 * inutile si elle n'arrive pas avec la demande.
 *
 * @param {{ email: string, objet: string, date: string, ip?: string }} data
 */
module.exports = ({ email, objet, date, ip }) => {
  const emailSafe = escapeHtml(email);
  const objetSafe = escapeHtml(objet);
  const dateSafe = escapeHtml(date);
  const ipSafe = escapeHtml(ip || '—');

  return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nouvelle demande de suppression de compte</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:#b91c1c;padding:24px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:20px;">🗑️ Demande de suppression de compte</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Une demande vient d'être déposée depuis la page publique
                  <strong>/suppression-compte</strong>.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;width:120px;">Email</td>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#1f2937;font-size:14px;font-weight:bold;">${emailSafe}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">Reçue le</td>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#1f2937;font-size:14px;">${dateSafe}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">IP d'origine</td>
                    <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;">${ipSafe}</td>
                  </tr>
                </table>

                <p style="margin:0 0 8px;color:#1f2937;font-size:14px;font-weight:bold;">Objet de la demande</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                  <tr>
                    <td style="padding:14px 16px;background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d;font-size:14px;line-height:1.6;white-space:pre-line;">${objetSafe}</td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:14px 16px;background:#fffbeb;border-left:4px solid #f59e0b;color:#78350f;font-size:13px;line-height:1.6;">
                      <strong>Délai de réponse : 30 jours</strong> à compter de la réception
                      (RGPD art. 12.3). Vérifiez l'identité du demandeur avant toute
                      suppression — cette adresse n'a pas été authentifiée.
                    </td>
                  </tr>
                </table>

                <p style="margin:22px 0 0;color:#9ca3af;font-size:12px;">
                  Retrouvez la demande dans l'administration, menu « Demandes de suppression ».
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;background:#f9fafb;text-align:center;color:#9ca3af;font-size:12px;">
                SuivieChantier — notification automatique
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
};
