'use strict';

const zlib = require('node:zlib');

/**
 * Extrait le texte lisible d'un PDF produit par pdfkit — outil de TEST.
 *
 * Pourquoi ce détour : les flux de contenu d'un PDF sont compressés
 * (FlateDecode), et pdfkit y écrit le texte via l'opérateur `TJ`, sous forme
 * de tableaux mêlant chaînes HEXADÉCIMALES (`<52415050...>`) et crénages
 * numériques. Le texte n'apparaît donc JAMAIS en clair dans le binaire :
 * chercher « Réserves » dans le buffer ne donnerait rien, et un test écrit
 * ainsi passerait pour de mauvaises raisons ou échouerait sans motif.
 *
 * On décompresse chaque flux, on isole les blocs `[...] TJ`, puis on décode
 * l'hexadécimal. Les octets obtenus sont du WinAnsi, que `latin1` restitue
 * correctement pour les accents français.
 *
 * @param {Buffer} buffer — le PDF complet
 * @returns {string} le texte imprimé, une ligne par bloc
 */
function lireTextePdf(buffer) {
  const morceaux = [];
  const bin = buffer.toString('latin1');
  const flux = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  let m = flux.exec(bin);
  while (m) {
    let contenu = null;
    try {
      contenu = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      // Flux non compressé (image, police) — sans texte à extraire.
    }

    if (contenu) {
      for (const bloc of contenu.match(/\[[\s\S]*?\]\s*TJ/g) || []) {
        let ligne = '';
        for (const hex of bloc.match(/<[0-9A-Fa-f]*>/g) || []) {
          const brut = hex.slice(1, -1);
          // Une longueur impaire signale un flux qu'on n'a pas su lire :
          // mieux vaut l'ignorer que d'injecter des octets faux dans le texte.
          if (brut.length % 2 === 0) {
            ligne += Buffer.from(brut, 'hex').toString('latin1');
          }
        }
        if (ligne) morceaux.push(ligne);
      }
    }
    m = flux.exec(bin);
  }

  return morceaux.join('\n');
}

/**
 * Même texte, sans accents et en majuscules — pour comparer des libellés de
 * section sans dépendre de l'encodage WinAnsi restitué par l'extraction.
 */
function lireTextePdfNormalise(buffer) {
  return lireTextePdf(buffer)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

module.exports = { lireTextePdf, lireTextePdfNormalise };
