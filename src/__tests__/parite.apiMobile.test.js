'use strict';

/**
 * Parité des routes : chaque appel HTTP du mobile vise-t-il une route montée ?
 *
 * ## Pourquoi ce test existe
 *
 * Le mobile écrit ses chemins en dur (`_dio.get('/chantiers/$id/plans')`).
 * Rien, dans aucun des deux dépôts, n'empêche de renommer une route côté
 * serveur ou de recopier un chemin approximatif côté client : la faute ne se
 * voit ni à la compilation Dart, ni au démarrage d'Express. Elle se voit en
 * production, sous forme de 404 sur un écran qui reste vide.
 *
 * Ce test relit `app.js` pour reconstruire la table des routes réellement
 * montées (préfixe + sous-chemin), relit les datasources du mobile pour en
 * extraire les appels, et confronte les deux.
 *
 * ## Ce qu'il ne prétend PAS faire
 *
 * Il compare des CHEMINS et des VERBES, rien d'autre. Un corps de requête mal
 * formé ou un paramètre de filtre inconnu passeront ici sans encombre — c'est
 * le rôle des tests de datasource, côté mobile.
 *
 * ## Dépôt mobile absent
 *
 * Les deux dépôts sont voisins mais indépendants. Quand `../mobile` n'est pas
 * là (CI backend seul), le test se déclare non pertinent plutôt que d'échouer :
 * un rouge qui ne signale l'absence d'un dossier n'apprend rien à personne.
 */

const fs = require('fs');
const path = require('path');

const RACINE_BACK = path.resolve(__dirname, '..');
const RACINE_MOBILE = path.resolve(__dirname, '..', '..', '..', 'mobile');
const DATASOURCES = path.join(RACINE_MOBILE, 'lib', 'features');

const mobilePresent = fs.existsSync(DATASOURCES);

/** Réduit `/reserves/:id/medias` et `/reserves/$id/medias` au même gabarit. */
const gabarit = (chemin) =>
  chemin
    .replace(/\$\{?[\w.]+\}?/g, ':P') // interpolation Dart
    .replace(/:\w+/g, ':P') // paramètre Express
    .replace(/\/+$/, '') || '/';

/** Table des routes montées, reconstruite depuis `app.js`. */
function routesMontees() {
  const app = fs.readFileSync(path.join(RACINE_BACK, 'app.js'), 'utf8');

  const requires = new Map();
  for (const [, nom, rel] of app.matchAll(/const\s+(\w+)\s*=\s*require\('([^']+)'\)/g)) {
    requires.set(nom, rel);
  }

  const table = new Set();
  for (const [, prefixe, variable] of app.matchAll(/app\.use\('(\/api\/v1[^']*)',\s*(\w+)\)/g)) {
    const rel = requires.get(variable);
    if (!rel || !rel.includes('route')) continue;

    const fichier = path.resolve(RACINE_BACK, rel);
    if (!fs.existsSync(fichier)) continue;

    const src = fs.readFileSync(fichier, 'utf8');
    for (const [, methode, sous] of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      const complet = (prefixe.replace(/\/$/, '') + sous).replace('/api/v1', '');
      table.add(`${methode.toUpperCase()} ${gabarit(complet)}`);
    }
  }
  return table;
}

/** Appels HTTP écrits dans les datasources du mobile. */
function appelsMobile() {
  const appels = [];
  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(complet);
      else if (entree.name.endsWith('.dart') && dossier.includes('datasources')) {
        const src = fs.readFileSync(complet, 'utf8');
        for (const [, methode, chemin] of src.matchAll(
          /\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']*)'/g
        )) {
          // Un chemin ENTIÈREMENT interpolé est construit ailleurs (référentiels
          // génériques) : sans sa valeur, il n'y a rien à confronter ici.
          if (chemin.startsWith('${')) continue;
          appels.push({ methode: methode.toUpperCase(), chemin, fichier: entree.name });
        }
      }
    }
  };
  if (mobilePresent) parcourir(DATASOURCES);
  return appels;
}

const decrire = mobilePresent ? describe : describe.skip;

decrire('parité des routes mobile ↔ backend', () => {
  const table = mobilePresent ? routesMontees() : new Set();
  const appels = appelsMobile();

  it('la table des routes est bien reconstruite', () => {
    // Garde-fou du test lui-même : si `app.js` change de style de montage, la
    // table tomberait à zéro et le test suivant passerait pour de mauvaises
    // raisons — il ne compare rien.
    expect(table.size).toBeGreaterThan(150);
    expect(appels.length).toBeGreaterThan(50);
  });

  it('chaque appel du mobile vise une route montée', () => {
    const orphelins = appels
      .filter(({ methode, chemin }) => !table.has(`${methode} ${gabarit(chemin)}`))
      .map(({ methode, chemin, fichier }) => `${methode} ${chemin}  (${fichier})`);

    expect(orphelins).toEqual([]);
  });
});
