'use strict';

/**
 * Échappe les caractères qui ont un sens en HTML.
 *
 * Les templates d'email interpolent des chaînes venues de l'extérieur : le nom
 * saisi à l'inscription, le motif de rejet tapé par l'admin. Sans échappement,
 * un `<` ou un `"` bien placé casse la mise en page du mail, et une balise
 * complète y injecte du contenu arbitraire — un lien maquillé, par exemple,
 * dans un email qui porte la signature de la plateforme.
 *
 * @param {unknown} valeur
 * @returns {string}
 */
module.exports = function escapeHtml(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
