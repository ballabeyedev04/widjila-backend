'use strict';

/**
 * URL d'une requête, débarrassée des SECRETS qu'elle peut porter — pour les
 * journaux d'accès (morgan, voir app.js).
 *
 * CORRECTIF (audit sécurité) : le format `combined` journalise l'URL telle
 * quelle. Le lien de partage d'un rapport (`/r/:token`, `/api/v1/r/:token`)
 * EST son propre secret : 256 bits dont la base ne garde que l'empreinte,
 * précisément pour qu'une fuite de la base ne suffise pas à l'ouvrir. Les
 * journaux, eux, le conservaient en clair — lisibles par quiconque accède aux
 * fichiers de logs ou à leur agrégateur, et pour toute leur durée de
 * rétention. Même chose pour un jeton passé en paramètre de requête.
 *
 * On masque la valeur, pas la route : le journal garde son utilité (qui a
 * ouvert un lien de partage, quand, avec quel statut).
 */
const MOTIFS = [
  // Lien de partage court ou long : /r/<jeton>
  [/(\/r\/)[^/?#]+/g, '$1[masqué]'],
  // Jetons passés en paramètre de requête
  [/([?&](?:token|token_payment|refreshToken|refresh_token|mfaToken|otp|code)=)[^&#]*/gi, '$1[masqué]'],
];

/**
 * @param {string} url
 * @returns {string}
 */
function masquerUrl(url) {
  let resultat = String(url || '');
  for (const [motif, remplacement] of MOTIFS) resultat = resultat.replace(motif, remplacement);
  return resultat;
}

module.exports = masquerUrl;
