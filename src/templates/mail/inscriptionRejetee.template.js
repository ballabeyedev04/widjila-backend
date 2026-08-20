'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Template email — demande d'inscription REJETÉE par le super-admin.
 *
 * Le motif est le cœur de ce message : c'est la seule explication que recevra
 * le demandeur. Il est saisi librement par l'admin, donc échappé, et rendu
 * avec `white-space:pre-line` pour conserver les retours à la ligne du champ.
 *
 * @param {{ nom: string, prenom: string, motif: string, organisationNom?: string }} data
 */
module.exports = ({ nom, prenom, motif, organisationNom }) => {
  const nomSafe = escapeHtml(nom);
  const prenomSafe = escapeHtml(prenom);
  const motifSafe = escapeHtml(motif);
  const orgSafe = escapeHtml(organisationNom);

  return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Suite à votre demande d'inscription</title>
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
                  Nous avons examiné votre demande d'inscription${orgSafe ? ` pour <strong>${orgSafe}</strong>` : ''}
                  et nous ne pouvons pas y donner suite pour le moment.
                </p>
                <p style="margin:0 0 8px;color:#1f2937;font-size:14px;font-weight:bold;">Motif</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                  <tr>
                    <td style="padding:14px 16px;background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d;font-size:14px;line-height:1.6;white-space:pre-line;">${motifSafe}</td>
                  </tr>
                </table>
                <p style="margin:0 0 16px;color:#4b5563;font-size:14px;line-height:1.6;">
                  Si vous pensez qu'il s'agit d'une erreur ou si vous souhaitez
                  compléter votre dossier, répondez à cet email ou contactez notre
                  support — votre demande pourra être réexaminée.
                </p>
                <p style="margin:0;color:#9ca3af;font-size:12px;">L'équipe SuivieChantier</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px;background:#f9fafb;text-align:center;color:#9ca3af;font-size:12px;">
                SuivieChantier — plateforme de suivi de chantier
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
