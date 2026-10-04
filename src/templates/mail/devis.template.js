'use strict';

const escapeHtml = require('../../utils/escapeHtml.js');

/**
 * Courriels du parcours « Premium sur devis » — trois variantes, un gabarit.
 *
 *   `accuse`  → au CLIENT, dès sa demande : nous l'avons bien reçue ;
 *   `demande` → au SUPER-ADMIN : une demande attend un chiffrage ;
 *   `pret`    → au CLIENT : son devis est disponible, avec le montant.
 *
 * ── Pourquoi ces courriels existent ───────────────────────────────────────
 *
 * Une demande de devis est une conversation commerciale, pas une action dans
 * un logiciel. Le patron qui l'envoie n'ouvre pas l'application chaque jour,
 * et le super-admin qui doit chiffrer non plus : une notification seule
 * laisse les deux attendre l'un l'autre. Le courriel est le canal qui
 * convient à ce rythme-là.
 *
 * ── Ce que `pret` contient, et ce qu'il ne contient pas ───────────────────
 *
 * Il contient le MONTANT : c'est l'information qu'on attend d'un devis, et
 * la cacher pour forcer l'ouverture de l'application serait un procédé.
 * Il ne contient PAS de bouton « accepter » : une acceptation engage, elle
 * se fait dans le produit, authentifiée, où la trace est gardée.
 *
 * @param {object} data
 * @param {'accuse'|'demande'|'pret'} data.variante
 * @param {string} data.numero             Numéro du devis (WDJ-2026-0001).
 * @param {string} [data.prenom]           Destinataire, si un seul.
 * @param {string} [data.organisationNom]  Organisation concernée.
 * @param {string} [data.montantTtc]       Déjà formaté avec sa devise (`pret`).
 * @param {number} [data.dureeMois]
 * @param {number|null} [data.limiteUtilisateurs] `null` = illimité.
 * @param {string} [data.validiteJusquau]  Date de validité, déjà formatée.
 * @param {object} [data.demande]          Ce que le client a demandé (`demande`).
 * @param {string} data.lien               Où agir.
 */
module.exports = ({
  variante, numero, prenom, organisationNom, montantTtc, dureeMois,
  limiteUtilisateurs, validiteJusquau, demande = {}, lien,
}) => {
  const bonjour = prenom ? `Bonjour ${escapeHtml(prenom)},` : 'Bonjour,';
  const org = organisationNom ? escapeHtml(organisationNom) : 'votre organisation';

  const TEXTES = {
    accuse: {
      titre: 'Votre demande de devis est bien reçue',
      corps: `Nous avons bien reçu votre demande de devis (<strong>${escapeHtml(numero)}</strong>) `
        + `pour ${org}. Notre équipe l'étudie et revient vers vous avec une proposition chiffrée.`,
      bouton: 'Suivre ma demande',
    },
    demande: {
      titre: 'Nouvelle demande de devis',
      corps: `<strong>${org}</strong> demande une proposition `
        + `(<strong>${escapeHtml(numero)}</strong>). Elle attend un chiffrage.`,
      bouton: 'Traiter la demande',
    },
    pret: {
      titre: 'Votre devis est disponible',
      corps: `Votre devis <strong>${escapeHtml(numero)}</strong> pour ${org} est prêt. `
        + 'Retrouvez-le dans votre espace Abonnement pour l’accepter ou le refuser.',
      bouton: 'Voir mon devis',
    },
  };

  const { titre, corps, bouton } = TEXTES[variante];

  /** Une ligne du récapitulatif — libellé en haut, valeur en dessous. */
  const ligne = (libelle, valeur, grande = false) => `
    <p style="margin:0 0 6px;color:#9c3d07;font-size:11px;font-weight:bold;letter-spacing:0.6px;">${escapeHtml(libelle)}</p>
    <p style="margin:0 0 14px;color:#1f2937;font-size:${grande ? '20px' : '15px'};font-weight:bold;">${escapeHtml(valeur)}</p>`;

  let encadre = '';

  if (variante === 'pret') {
    encadre = [
      montantTtc ? ligne('MONTANT TTC', montantTtc, true) : '',
      dureeMois ? ligne('DURÉE', `${dureeMois} mois`) : '',
      ligne('UTILISATEURS', limiteUtilisateurs == null ? 'Illimité' : String(limiteUtilisateurs)),
      validiteJusquau ? ligne('VALABLE JUSQU’AU', validiteJusquau) : '',
    ].join('');
  } else if (variante === 'demande') {
    // Ce que le client a demandé : c'est ce qui permet de préparer le
    // chiffrage avant même d'ouvrir l'administration.
    encadre = [
      demande.contact ? ligne('CONTACT', demande.contact) : '',
      demande.nbUtilisateurs != null ? ligne('UTILISATEURS SOUHAITÉS', String(demande.nbUtilisateurs)) : '',
      demande.nbChantiers != null ? ligne('CHANTIERS SOUHAITÉS', String(demande.nbChantiers)) : '',
      demande.dureeSouhaitee != null ? ligne('DURÉE SOUHAITÉE', `${demande.dureeSouhaitee} mois`) : '',
    ].join('');
  }

  // Les besoins du client en texte libre : hors de l'encadré, ils peuvent
  // être longs. `escapeHtml` d'abord, saut de ligne ensuite — l'inverse
  // laisserait passer une balise.
  const besoins = variante === 'demande' && demande.besoins
    ? `<tr><td style="padding:4px 32px 0;">
         <p style="margin:0;color:#374151;font-size:13.5px;line-height:1.6;white-space:pre-line;">${escapeHtml(demande.besoins)}</p>
       </td></tr>`
    : '';

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
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.6;">${corps}</p>
          </td>
        </tr>
        ${encadre ? `<tr>
          <td style="padding:0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4ec;border-radius:10px;">
              <tr><td style="padding:18px 18px 4px;">${encadre}</td></tr>
            </table>
          </td>
        </tr>` : ''}
        ${besoins}
        <tr>
          <td align="center" style="padding:22px 32px 6px;">
            <a href="${escapeHtml(lien)}"
               style="display:inline-block;background:#f2600c;color:#ffffff;text-decoration:none;
                      font-size:14px;font-weight:bold;padding:12px 26px;border-radius:9px;">
              ${escapeHtml(bouton)}
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 32px 30px;">
            <p style="margin:0;color:#6b7280;font-size:12.5px;line-height:1.6;">
              ${variante === 'demande'
                ? 'Chiffrez la demande depuis l’espace Plateforme, puis transmettez le devis au client.'
                : 'Une question sur cette proposition ? Répondez simplement à ce message.'}
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
