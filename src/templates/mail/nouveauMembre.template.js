'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Template email — un membre vient d'être ajouté à une organisation.
 *
 * ## Ce que ce courriel remplace
 *
 * Le mot de passe temporaire n'était affiché QUE dans une fenêtre, côté
 * mobile, avec un bouton « J'ai noté ». Il n'était renvoyé qu'une seule fois
 * par le serveur : refermer la fenêtre trop vite, ou perdre l'application au
 * mauvais moment, et le compte devenait inutilisable — il fallait le recréer.
 * Et même lorsque tout se passait bien, il restait à transmettre ce mot de
 * passe à l'intéressé « par un canal sûr », c'est-à-dire, en pratique, par
 * SMS ou par messagerie instantanée.
 *
 * Le courriel va directement à la personne concernée. Elle a ses identifiants
 * sans intermédiaire, et sans qu'ils transitent par un tiers.
 *
 * ## Pourquoi le mot de passe est écrit en clair dans le message
 *
 * Il est TEMPORAIRE : le compte est marqué `mdp_temporaire`, l'application
 * exige d'en choisir un autre à la première connexion. Sa durée de vie utile
 * est donc d'une seule ouverture de session. L'alternative — un lien de
 * définition de mot de passe — serait plus sûre, mais suppose une page
 * publique dédiée qui n'existe pas encore ; l'annoncer ici serait promettre ce
 * qui n'est pas construit.
 *
 * @param {{
 *   prenom: string, nom: string,
 *   auteurNom: string, organisationNom: string, role: string,
 *   email: string, motDePasse: string|null, lien: string,
 * }} data
 */
module.exports = ({
  prenom, nom, auteurNom, organisationNom, role, email, motDePasse, lien,
}) => {
  const prenomSafe = escapeHtml(prenom);
  const nomSafe = escapeHtml(nom);
  const auteurSafe = escapeHtml(auteurNom);
  const orgSafe = escapeHtml(organisationNom);
  const roleSafe = escapeHtml(role);
  const emailSafe = escapeHtml(email);
  const mdpSafe = motDePasse ? escapeHtml(motDePasse) : null;

  // Bloc d'identifiants — le mot de passe n'y figure que s'il a été GÉNÉRÉ.
  // Quand la personne qui a créé le compte en a choisi un elle-même, le
  // serveur ne le connaît qu'en empreinte : annoncer une ligne « mot de
  // passe » vide serait pire que de ne rien dire.
  const ligneMotDePasse = mdpSafe
    ? `
                    <tr>
                      <td style="padding:6px 0;color:#6b7280;font-size:13px;">Mot de passe&nbsp;:</td>
                      <td style="padding:6px 0;color:#111827;font-size:15px;font-weight:bold;font-family:'Courier New',monospace;letter-spacing:1px;">${mdpSafe}</td>
                    </tr>`
    : '';

  const noteMotDePasse = mdpSafe
    ? `Ce mot de passe est <strong>temporaire</strong> : il vous sera demandé d'en choisir un nouveau dès votre première connexion.`
    : `Utilisez le mot de passe qui vous a été communiqué par ${auteurSafe}.`;

  return `
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vous avez été ajouté à ${orgSafe}</title>
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
                <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">
                  <strong>${auteurSafe}</strong>, de l'entreprise <strong>${orgSafe}</strong>,
                  vous a ajouté en tant que <strong>${roleSafe}</strong>.
                </p>

                <p style="margin:0 0 10px;color:#1f2937;font-size:14px;font-weight:bold;">Identifiants de connexion</p>
                <table role="presentation" width="100%" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:0 0 18px;">
                  <tr>
                    <td style="padding:6px 0;color:#6b7280;font-size:13px;width:120px;">Email&nbsp;:</td>
                    <td style="padding:6px 0;color:#111827;font-size:15px;font-weight:bold;">${emailSafe}</td>
                  </tr>${ligneMotDePasse}
                </table>

                <p style="margin:0 0 24px;color:#4b5563;font-size:14px;line-height:1.6;">
                  ${noteMotDePasse}
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
