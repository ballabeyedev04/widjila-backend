'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Courriel accompagnant le reçu de paiement.
 *
 * Volontairement court : la pièce jointe porte le détail, le message ne fait
 * que l'annoncer et dire l'essentiel — quelle formule, quel montant. Un
 * courriel qui répète le PDF donne deux versions à tenir d'accord.
 *
 * @param {object} data
 * @param {string} [data.prenom]           Prénom du payeur.
 * @param {string} [data.organisationNom]  Organisation réglée.
 * @param {string} data.planNom            Formule souscrite.
 * @param {string} data.montant            Montant déjà formaté avec sa devise.
 * @param {string} data.numero             Numéro du reçu joint.
 */
module.exports = ({ prenom, organisationNom, planNom, montant, numero }) => {
  const bonjour = prenom ? `Bonjour ${escapeHtml(prenom)},` : 'Bonjour,';
  const org = organisationNom ? escapeHtml(organisationNom) : '';

  return `<!doctype html>
<html lang="fr">
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="height:5px;background:#f2600c;"></td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0 0 14px;color:#1f2937;font-size:15px;">${bonjour}</p>
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.6;">
              Nous confirmons le règlement de votre abonnement${org ? ` pour <strong>${org}</strong>` : ''}.
              Votre reçu est joint à ce message au format PDF.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4ec;border-radius:10px;">
              <tr>
                <td style="padding:16px 18px;">
                  <p style="margin:0 0 6px;color:#9c3d07;font-size:11px;font-weight:bold;letter-spacing:0.6px;">FORMULE</p>
                  <p style="margin:0 0 14px;color:#1f2937;font-size:15px;font-weight:bold;">${escapeHtml(planNom)}</p>
                  <p style="margin:0 0 6px;color:#9c3d07;font-size:11px;font-weight:bold;letter-spacing:0.6px;">MONTANT RÉGLÉ</p>
                  <p style="margin:0;color:#1f2937;font-size:20px;font-weight:bold;">${escapeHtml(montant)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 30px;">
            <p style="margin:0;color:#6b7280;font-size:12.5px;line-height:1.6;">
              Reçu n° ${escapeHtml(numero)} — conservez-le pour votre comptabilité.
              Vous le retrouverez également dans l'historique de vos paiements, depuis l'application.
            </p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;color:#9ca3af;font-size:11px;">Widjila — Suivi de chantier</p>
    </td></tr>
  </table>
</body>
</html>`;
};
