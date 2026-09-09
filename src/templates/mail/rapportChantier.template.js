'use strict';

/**
 * Courriel d'envoi d'un rapport de chantier à l'entreprise concernée.
 *
 * Le texte reprend mot pour mot celui demandé par le client. Il reste court :
 * l'information est dans la pièce jointe, et un message long ferait passer le
 * rapport pour un accessoire.
 */
module.exports = function rapportChantierTemplate({ chantierNom, expediteur, nbReserves }) {
  const reserves = Number.isInteger(nbReserves)
    ? `<p style="margin:0 0 16px">Ce rapport contient l\u2019ensemble des r\u00e9serves enregistr\u00e9es \u00e0 ce jour (${nbReserves}).</p>`
    : '<p style="margin:0 0 16px">Ce rapport contient l\u2019ensemble des r\u00e9serves enregistr\u00e9es \u00e0 ce jour.</p>';

  return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#f3f5f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
    <tr><td>
      <p style="margin:0 0 16px">Bonjour,</p>
      <p style="margin:0 0 16px">
        Veuillez trouver en pi\u00e8ce jointe le rapport de chantier concernant
        <strong>${chantierNom}</strong>.
      </p>
      ${reserves}
      <p style="margin:0">Cordialement,<br>${expediteur}</p>
    </td></tr>
  </table>
</body></html>`;
};
