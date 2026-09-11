'use strict';

const path = require('path');

/** U+FFFD, produit par un décodage UTF-8 sur des octets invalides. */
const CARACTERE_REMPLACEMENT = String.fromCharCode(0xFFFD);

/**
 * Nom d'origine d'un fichier reçu en multipart, tel que l'utilisateur l'a vu.
 *
 * multer (busboy) décode le paramètre `filename` en latin1 quand le client ne
 * précise pas d'encodage — ce que ne font ni Dio (mobile) ni la plupart des
 * navigateurs, qui envoient pourtant de l'UTF-8 brut. « Procès-verbal.pdf »
 * arrivait donc en « ProcÃ¨s-verbal.pdf », et c'est ce nom abîmé qui était
 * enregistré puis affiché dans la GED.
 *
 * Les octets ne sont réinterprétés en UTF-8 que si le résultat est valide : un
 * vrai nom latin1 (« café » avec un é sur un seul octet) donnerait un caractère
 * de remplacement, et reste alors tel quel.
 *
 * Le résultat est aussi borné : `documents.nom_fichier` est un VARCHAR(255),
 * un nom plus long faisait échouer l'insertion après l'envoi sur le stockage.
 *
 * @param {string} brut — `file.originalname` fourni par multer
 * @param {number} [longueurMax]
 * @returns {string}
 */
function nomFichierOriginal(brut, longueurMax = 200) {
  let nom = String(brut == null ? '' : brut);

  const toutEnOctets = [...nom].every((c) => c.charCodeAt(0) <= 0xFF);
  const aDesOctetsHauts = [...nom].some((c) => c.charCodeAt(0) >= 0x80);
  if (toutEnOctets && aDesOctetsHauts) {
    const utf8 = Buffer.from(nom, 'latin1').toString('utf8');
    if (!utf8.includes(CARACTERE_REMPLACEMENT)) nom = utf8;
  }

  // Dernier segment seulement, sans caractères de contrôle.
  nom = nom.split(/[\\/]/).pop();
  nom = [...nom].filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code !== 0x7F;
  }).join('').trim();

  if (!nom) return 'document';

  if (nom.length > longueurMax) {
    // On tronque le NOM et on garde l'extension : c'est elle qui dit au
    // téléphone quelle application ouvrira le fichier.
    const ext = path.extname(nom).slice(0, 12);
    nom = nom.slice(0, longueurMax - ext.length) + ext;
  }
  return nom;
}

module.exports = nomFichierOriginal;
