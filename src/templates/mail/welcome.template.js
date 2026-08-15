'use strict';

/**
 * Template email de bienvenue à l'inscription.
 * @param {{ nom: string, prenom: string }} data
 */
module.exports = ({ nom, prenom }) => `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bienvenue 🎉</title>
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
                <h2 style="margin:0 0 12px;color:#1f2937;font-size:18px;">Bienvenue ${prenom} ${nom} !</h2>
                <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
                  Votre compte a été créé avec succès. Vous pouvez dès maintenant :
                </p>
                <ul style="margin:0 0 20px;padding-left:20px;color:#4b5563;font-size:14px;line-height:1.8;">
                  <li>Créer et organiser vos chantiers</li>
                  <li>Importer des plans et poser des réserves</li>
                  <li>Suivre le cycle de vie des réserves avec votre équipe</li>
                  <li>Générer des rapports et PV de visites</li>
                </ul>
                <p style="margin:0;color:#6b7280;font-size:13px;">
                  Besoin d'aide ? Notre équipe est là pour vous accompagner.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;background:#f9fafb;text-align:center;color:#9ca3af;font-size:12px;">
                © ${new Date().getFullYear()} SuivieChantier — Gestion des réserves de chantier
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
