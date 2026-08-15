'use strict';

/**
 * Template email de vérification d'adresse (inscription).
 * @param {{ nom: string, prenom: string, lien: string }} data
 */
module.exports = ({ nom, prenom, lien }) => `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vérifiez votre adresse email</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:#1d4ed8;padding:24px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:20px;">🏗️ SuivieChantier</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h2 style="margin:0 0 12px;color:#1f2937;font-size:18px;">Bonjour ${nom} ${prenom},</h2>
                <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Merci de vous être inscrit. Veuillez confirmer votre adresse email
                  en cliquant sur le bouton ci-dessous :
                </p>
                <p style="margin:0 0 20px;text-align:center;">
                  <a href="${lien}" style="display:inline-block;padding:14px 32px;background:#1d4ed8;color:#ffffff;font-size:15px;font-weight:bold;border-radius:8px;text-decoration:none;">Vérifier mon email</a>
                </p>
                <p style="margin:0 0 8px;color:#6b7280;font-size:13px;line-height:1.6;">
                  Ce lien expire dans <strong>24 heures</strong>. Si vous n'êtes pas à
                  l'origine de cette inscription, vous pouvez ignorer cet email.
                </p>
                <p style="margin:0;color:#9ca3af;font-size:12px;">L'équipe SuivieChantier</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
