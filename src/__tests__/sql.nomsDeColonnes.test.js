'use strict';

/**
 * Les références SQL brutes visent-elles des colonnes qui existent ?
 *
 * ## Le défaut que ce test rend impossible
 *
 * Sequelize traduit les noms d'ATTRIBUTS quand le modèle est déclaré
 * `underscored: true` : écrire `where: { createdAt: ... }` interroge bien
 * `created_at`.
 *
 * `col()` ne traduit rien. La chaîne part telle quelle dans le SQL.
 *
 * Les deux écritures se côtoient dans le même objet de requête :
 *
 *     Reserve.findAll({
 *       where:      { createdAt: { [Op.gte]: depuis } },   // traduit  → OK
 *       attributes: [[fn('to_char', col('createdAt'), ...)]], // brut  → 500
 *     })
 *
 * L'une est correcte, l'autre non, et rien ne les distingue à la lecture.
 * PostgreSQL rejette la seconde — « column "createdAt" does not exist » —
 * et l'endpoint répond 500. C'est ce qui faisait tomber le tableau de bord
 * plateforme et la courbe d'évolution des réserves.
 *
 * ## Pourquoi une liste d'exceptions plutôt qu'une interdiction
 *
 * 40 des 45 modèles sont `underscored`, mais cinq ne le sont pas : pour
 * ceux-là, une référence en camel est CORRECTE. Interdire la forme partout
 * serait faux ; l'autoriser sans contrôle laisserait revenir le défaut.
 *
 * La liste est donc vide aujourd'hui, et toute nouvelle entrée demande de
 * nommer le modèle concerné — c'est-à-dire de vérifier qu'il n'est pas
 * `underscored` avant d'écrire la ligne.
 */

const fs = require('fs');
const path = require('path');

const MODULES = path.resolve(__dirname, '..', 'modules');
const MODELES = path.resolve(__dirname, '..', 'models');

/**
 * Références `col()` en camelCase tolérées, avec le modèle qui les justifie.
 *
 * Format : `<fichier>:<référence>` → nom du modèle NON `underscored`.
 */
const TOLEREES = new Map([
  // (vide — aucune référence camelCase n'est nécessaire aujourd'hui)
]);

/** Modèles dont les colonnes restent en camelCase. */
function modelesNonUnderscored() {
  const noms = new Set();
  for (const f of fs.readdirSync(MODELES)) {
    if (!f.endsWith('.model.js')) continue;
    const src = fs.readFileSync(path.join(MODELES, f), 'utf8');
    if (/underscored:\s*true/.test(src)) continue;
    const m = /sequelize\.define\(\s*'(\w+)'/.exec(src);
    if (m) noms.add(m[1]);
  }
  return noms;
}

/**
 * Retire commentaires de bloc et de ligne.
 *
 * Sans cela, le balayage se signale lui-même : la documentation qui EXPLIQUE
 * le piège cite forcément la forme fautive, et le test tomberait sur son
 * propre commentaire.
 */
function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Toutes les références `col('...')` du code métier. */
function referencesBrutes(dossier = MODULES, acc = []) {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) referencesBrutes(complet, acc);
    else if (entree.name.endsWith('.js')) {
      const src = sansCommentaires(fs.readFileSync(complet, 'utf8'));
      for (const [, ref] of src.matchAll(/\bcol\(\s*'([^']+)'\s*\)/g)) {
        acc.push({ fichier: entree.name, ref, cle: `${entree.name}:${ref}` });
      }
    }
  }
  return acc;
}

const camel = (s) => /[a-z][A-Z]/.test(s);

describe('références de colonnes SQL', () => {
  const refs = referencesBrutes();

  it('le balayage trouve bien des références', () => {
    // Garde-fou : si `col()` disparaissait du code ou changeait de forme, le
    // test suivant passerait sans rien vérifier.
    expect(refs.length).toBeGreaterThan(3);
  });

  it('aucune référence brute n’est écrite en camelCase', () => {
    const fautives = refs
      .filter((r) => camel(r.ref) && !TOLEREES.has(r.cle))
      .map((r) => `${r.fichier} → col('${r.ref}')`);

    expect(fautives).toEqual([]);
  });

  it('les tolérances déclarées visent bien un modèle NON underscored', () => {
    // Une tolérance posée pour un modèle `underscored` serait une erreur
    // maquillée en exception.
    const nonUnderscored = modelesNonUnderscored();
    const abusives = [...TOLEREES.entries()]
      .filter(([, modele]) => !nonUnderscored.has(modele))
      .map(([cle, modele]) => `${cle} (modèle ${modele})`);

    expect(abusives).toEqual([]);
  });

  it('les tolérances déclarées correspondent à du code réel', () => {
    const existantes = new Set(refs.map((r) => r.cle));
    const orphelines = [...TOLEREES.keys()].filter((c) => !existantes.has(c));

    expect(orphelines).toEqual([]);
  });
});
