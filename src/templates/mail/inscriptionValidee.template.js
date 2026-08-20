'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Template email — demande d'inscription VALIDÉE par le super-admin.
 * Le compte devient utilisable immédiatement, d'où le bouton de connexion.
 *
 * @param {{ nom: string, prenom: string, lien: string, organisationNom?: string }} data
 */
module.exports = ({ nom, prenom, lien, organisationNom }) => {
  const nomSafe = escapeHtml(nom);
  const prenomSafe = escapeHtml(prenom);
  const orgSafe = escapeHtml(organisationNom);

  return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Votre compte est activé</title>
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
                <h2 style="margin:0 0 12px;color:#1f2937;font-size:18px;">Bonjour ${prenomSafe} ${nomSafe},</h2>
                <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Bonne nouvelle : votre demande d'inscription${orgSafe ? ` pour <strong>${orgSafe}</strong>` : ''}
                  vient d'être <strong style="color:#16a34a;">validée</strong>.
                </p>
                <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Votre compte est actif. Vous pouvez dès maintenant vous connecter
                  avec l'adresse email et le mot de passe choisis à l'inscription.
                </p>
                <p style="margin:0 0 24px;text-align:center;">
                  <a href="${lien}" style="display:inline-block;padding:14px 32px;background:#1d4ed8;color:#ffffff;font-size:15px;font-weight:bold;border-radius:8px;text-decoration:none;">Me connecter</a>
                </p>
                <p style="margin:0;color:#9ca3af;font-size:12px;">L'équipe SuivieChantier</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;background:#f9fafb;text-align:center;color:#9ca3af;font-size:12px;">
                Cet email vous a été envoyé automatiquement, merci de ne pas y répondre.
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
