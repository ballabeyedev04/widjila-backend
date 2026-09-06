'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Template email — circuit de validation d'un chantier.
 *
 * Un seul gabarit pour les trois messages (demande déposée, demande acceptée,
 * demande refusée) : la mise en page est identique, seuls le bandeau, le
 * paragraphe d'ouverture et l'encadré changent. Trois fichiers auraient dérivé
 * l'un de l'autre à la première retouche de style.
 *
 * Le motif de refus est saisi librement par le valideur : il est échappé, et
 * rendu en `white-space:pre-line` pour conserver les retours à la ligne.
 *
 * @param {object} data
 * @param {'demande'|'validee'|'rejetee'} data.variante
 * @param {string} data.destinataire  Prénom ou nom d'usage du lecteur.
 * @param {string} data.chantierNom
 * @param {string} [data.chantierCode]
 * @param {string} [data.demandeurNom]  Auteur de la demande (variante 'demande').
 * @param {string} [data.motif]         Obligatoire pour 'rejetee'.
 * @param {string} [data.lien]          Bouton d'action.
 */
module.exports = ({ variante, destinataire, chantierNom, chantierCode, demandeurNom, organisationNom, motif, lien }) => {
  const nomSafe = escapeHtml(destinataire);
  const chantierSafe = escapeHtml(chantierNom);
  const codeSafe = escapeHtml(chantierCode);
  const demandeurSafe = escapeHtml(demandeurNom);
  const organisationSafe = escapeHtml(organisationNom);

  // « L'entreprise Sotraco (Moussa Diop) » quand l'organisation est connue,
  // « Moussa Diop » sinon. Un super-admin reçoit les demandes de TOUTES les
  // organisations : sans le nom de la société, il ne sait pas de qui vient
  // celle qu'il lit.
  const auteurSafe = organisationSafe
    ? `l’entreprise ${organisationSafe}${demandeurSafe ? ` (${demandeurSafe})` : ''}`
    : demandeurSafe;
  const motifSafe = escapeHtml(motif);

  const TEXTES = {
    demande: {
      couleur: '#1d4ed8',
      titre: 'Nouvelle demande de chantier',
      intro: `<strong>${auteurSafe}</strong> a déposé une demande de création de chantier. Elle attend votre décision : tant qu'elle n'est pas validée, le chantier n'apparaît pas dans la liste des chantiers en activité, et les plans qui y sont joints restent eux aussi en attente.`,
      bouton: 'Examiner la demande',
    },
    validee: {
      couleur: '#15803d',
      titre: 'Votre chantier est validé',
      intro: 'Votre demande de création de chantier a été acceptée. Le chantier est désormais actif : vous pouvez y ajouter votre structure, vos plans et vos réserves.',
      bouton: 'Ouvrir le chantier',
    },
    rejetee: {
      couleur: '#b91c1c',
      titre: 'Votre demande de chantier n’a pas été retenue',
      intro: 'Votre demande de création de chantier n’a pas été acceptée en l’état. Le motif ci-dessous indique ce qui doit être repris — vous pouvez corriger votre demande et la renvoyer.',
      bouton: 'Corriger ma demande',
    },
  };

  const t = TEXTES[variante] || TEXTES.demande;

  const encadreMotif = motifSafe
    ? `
                <p style="margin:0 0 8px;color:#1f2937;font-size:14px;font-weight:bold;">Motif</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                  <tr>
                    <td style="padding:14px 16px;background:#fef2f2;border-left:4px solid #dc2626;color:#7f1d1d;font-size:14px;line-height:1.6;white-space:pre-line;">${motifSafe}</td>
                  </tr>
                </table>`
    : '';

  const bouton = lien
    ? `
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                  <tr>
                    <td style="border-radius:8px;background:${t.couleur};">
                      <a href="${escapeHtml(lien)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">${t.bouton}</a>
                    </td>
                  </tr>
                </table>`
    : '';

  return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${t.titre}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:${t.couleur};padding:24px;text-align:center;">
                <h1 style="margin:0;color:#ffffff;font-size:20px;">🏗️ SuivieChantier</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h2 style="margin:0 0 12px;color:#1f2937;font-size:18px;">Bonjour ${nomSafe},</h2>
                <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">${t.intro}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
                  <tr>
                    <td style="padding:14px 16px;background:#f9fafb;border-left:4px solid ${t.couleur};color:#1f2937;font-size:15px;line-height:1.6;">
                      <strong>${chantierSafe}</strong>${codeSafe ? `<br /><span style="color:#6b7280;font-size:13px;">${codeSafe}</span>` : ''}
                    </td>
                  </tr>
                </table>${encadreMotif}${bouton}
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
