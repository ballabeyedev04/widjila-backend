'use strict';

/**
 * Courriel de diffusion d'un rapport de réserves — § 13 du cahier des charges
 * du module Rapports.
 *
 * Deux formes, décidées par le poids du document :
 *   - le PDF est JOINT quand il est léger ;
 *   - un LIEN SÉCURISÉ le remplace quand il est lourd en photos, parce qu'une
 *     pièce jointe de 30 Mo est refusée par la moitié des serveurs de
 *     messagerie — et qu'un envoi refusé ne prévient personne.
 *
 * Le message reste court : l'information est dans le rapport. Le texte libre
 * saisi par l'utilisateur, s'il y en a un, prend la place du texte par défaut
 * — c'est lui qui connaît le contexte de son envoi.
 */

/** Échappe le texte saisi : il finit dans du HTML, et vient d'un formulaire. */
function echapper(texte) {
  return String(texte || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = function rapportDiffusionTemplate({
  chantierNom,
  rapportNom,
  expediteur,
  nbReserves,
  message = null,
  lien = null,
  expireLe = null,
  organisation = null,
}) {
  const corps = message
    ? echapper(message).split('\n').map((l) => `<p style="margin:0 0 10px">${l || '&nbsp;'}</p>`).join('')
    : `<p style="margin:0 0 16px">Bonjour,</p>
       <p style="margin:0 0 16px">
         Veuillez trouver ${lien ? 'ci-dessous le lien vers' : 'en pièce jointe'} le rapport de réserves
         concernant <strong>${echapper(chantierNom)}</strong>.
       </p>`;

  const compte = Number.isInteger(nbReserves)
    ? `<p style="margin:0 0 16px;color:#52606e">Ce rapport porte sur ${nbReserves} réserve(s).</p>`
    : '';

  const bouton = lien
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">
         <tr><td style="background:#f2600c;border-radius:10px">
           <a href="${echapper(lien)}" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font-weight:700">
             Ouvrir le rapport
           </a>
         </td></tr>
       </table>
       <p style="margin:0 0 16px;color:#52606e;font-size:13px">
         Ce lien est personnel et ne doit pas être rediffusé.
         ${expireLe ? `Il expire le ${echapper(expireLe)}.` : ''}
       </p>`
    : '';

  return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#f3f5f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
    <tr><td>
      <p style="margin:0 0 6px;color:#f2600c;font-weight:700;font-size:13px">WIDJILA</p>
      <h1 style="margin:0 0 18px;font-size:18px">${echapper(rapportNom || 'Rapport de réserves')}</h1>
      ${corps}
      ${compte}
      ${bouton}
      <p style="margin:0">Cordialement,<br>${echapper(expediteur)}${organisation ? `<br><span style="color:#52606e">${echapper(organisation)}</span>` : ''}</p>
    </td></tr>
  </table>
</body></html>`;
};
