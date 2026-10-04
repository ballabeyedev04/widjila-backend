'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Courriel d'échéance d'abonnement — deux variantes, un seul gabarit.
 *
 *   `approche` : l'échéance arrive (J-30, J-7, J-1) ;
 *   `expire`   : elle est passée.
 *
 * ── Le ton, et pourquoi il compte ─────────────────────────────────────────
 *
 * Ce message annonce une fin de contrat à une entreprise qui a confié des
 * mois de relevés à l'application. Un courriel alarmant — « accès suspendu »,
 * « données bloquées » — pousse à exporter et à partir ; or il ne se passera
 * rien de tel : l'organisation bascule sur l'offre gratuite et garde tout.
 * On le dit donc explicitement, et dès le premier rappel.
 *
 * Un seul appel à l'action : voir l'abonnement. Pas de tarif dans le
 * courriel — les formules vivent dans le produit, et un prix recopié ici
 * finirait par diverger du catalogue.
 *
 * @param {object} data
 * @param {'approche'|'expire'} data.variante
 * @param {string} [data.prenom]          Prénom du destinataire.
 * @param {string} [data.organisationNom] Organisation concernée.
 * @param {string} data.planNom           Formule en cours.
 * @param {string} [data.dateFin]         Échéance, déjà formatée.
 * @param {number} [data.jours]           Jours restants (variante `approche`).
 * @param {number} data.limiteChantiers   Plafond de l'offre gratuite.
 * @param {number} data.limiteUtilisateurs
 * @param {string} data.lien              Adresse de l'écran Abonnement.
 */
module.exports = ({
  variante, prenom, organisationNom, planNom, dateFin, jours,
  limiteChantiers, limiteUtilisateurs, lien,
}) => {
  const bonjour = prenom ? `Bonjour ${escapeHtml(prenom)},` : 'Bonjour,';
  const org = organisationNom ? escapeHtml(organisationNom) : 'votre organisation';
  const approche = variante === 'approche';

  const titre = approche
    ? (jours <= 1
      ? 'Votre abonnement expire demain'
      : `Votre abonnement expire dans ${jours} jours`)
    : 'Votre abonnement est arrivé à échéance';

  const introduction = approche
    ? `La formule <strong>${escapeHtml(planNom)}</strong> de <strong>${org}</strong> arrive à échéance`
      + `${dateFin ? ` le <strong>${escapeHtml(dateFin)}</strong>` : ''}.`
    : `La formule <strong>${escapeHtml(planNom)}</strong> de <strong>${org}</strong> est arrivée à échéance.`;

  const suite = approche
    ? 'Pour la reconduire, rendez-vous dans votre espace Abonnement.'
    : 'Vous pouvez la reconduire à tout moment depuis votre espace Abonnement.';

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
            <h1 style="margin:0 0 14px;color:#1f2937;font-size:18px;">${escapeHtml(titre)}</h1>
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.6;">
              ${introduction} ${escapeHtml(suite)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4ec;border-radius:10px;">
              <tr>
                <td style="padding:16px 18px;">
                  <p style="margin:0 0 6px;color:#9c3d07;font-size:11px;font-weight:bold;letter-spacing:0.6px;">SANS RECONDUCTION</p>
                  <p style="margin:0;color:#374151;font-size:13.5px;line-height:1.6;">
                    Vos chantiers, vos réserves et vos photos <strong>restent accessibles</strong>.
                    ${org} ${approche ? 'basculera' : 'est passée'} sur l'offre gratuite :
                    ${limiteChantiers} chantier et ${limiteUtilisateurs} utilisateurs,
                    toutes les fonctionnalités comprises.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:22px 32px 6px;">
            <a href="${escapeHtml(lien)}"
               style="display:inline-block;background:#f2600c;color:#ffffff;text-decoration:none;
                      font-size:14px;font-weight:bold;padding:12px 26px;border-radius:9px;">
              Voir mon abonnement
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 32px 30px;">
            <p style="margin:0;color:#6b7280;font-size:12.5px;line-height:1.6;">
              Une question sur votre contrat ? Répondez simplement à ce message.
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
