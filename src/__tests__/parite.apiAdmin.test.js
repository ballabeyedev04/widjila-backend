'use strict';

/**
 * Parité des routes : chaque appel HTTP du PORTAIL ADMIN vise-t-il une route
 * montée ?
 *
 * ## Pourquoi ce test existe
 *
 * Le même contrôle existait pour le mobile (`parite.apiMobile.test.js`), et
 * pas pour le portail web. C'est pourtant le portail où travaille le
 * super-admin : il y valide les inscriptions, les demandes de chantier et
 * leurs plans, il y traite les demandes de suppression RGPD.
 *
 * Le défaut trouvé grâce à ce contrôle : `POST /auth/verify-email`. Le
 * parcours de vérification par email avait été RETIRÉ côté serveur — le
 * compte est désormais ouvert par le super-admin, qui joue le rôle d'acteur de
 * confiance — mais le portail gardait sa page, sa route publique et son appel.
 * Quiconque suivait un ancien lien lisait « Lien invalide ou expiré », un
 * message qui accuse son lien alors que c'est la route serveur qui n'existait
 * plus.
 *
 * Rien, dans aucun des deux dépôts, n'empêchait cette dérive : la faute ne se
 * voit ni à la compilation, ni au démarrage d'Express. Elle se voit en
 * production, sur un écran qui affiche une erreur trompeuse.
 *
 * ## Deux façons de monter une route, et il fallait les deux
 *
 * `app.js` monte l'essentiel par `app.use('/api/v1/x', routeur)`. Mais les
 * référentiels de TYPE — documents, intervenants, inspections — sont montés
 * dans une BOUCLE :
 *
 * ```js
 * for (const { chemin, routeur } of referentiels) app.use(`/api/v1${chemin}`, routeur);
 * ```
 *
 * Un extracteur qui n'en tient pas compte déclare orphelins les six appels du
 * portail vers ces trois référentiels — six faux positifs qui feraient
 * abandonner le test au premier passage. Le montage en boucle est donc lu à
 * part, depuis la liste qui le nourrit.
 *
 * ## Ce qu'il ne prétend PAS faire
 *
 * Il compare des CHEMINS et des VERBES, rien d'autre. Un corps mal formé ou un
 * paramètre de filtre inconnu passeront ici sans encombre.
 *
 * ## Portail absent
 *
 * Les deux dépôts sont voisins mais indépendants. Quand `../admin` n'est pas
 * là (CI backend seul), le test se déclare non pertinent plutôt que d'échouer.
 */

const fs = require('fs');
const path = require('path');

const RACINE_BACK = path.resolve(__dirname, '..');
const RACINE_ADMIN = path.resolve(__dirname, '..', '..', '..', 'admin');
const SERVICES = path.join(RACINE_ADMIN, 'src', 'service');

const adminPresent = fs.existsSync(SERVICES);

/** Réduit `/reserves/:id/medias` et `` `/reserves/${id}/medias` `` au même gabarit. */
const gabarit = (chemin) =>
  chemin
    .replace(/\$\{[^}]*\}/g, ':P') // interpolation JavaScript
    .replace(/:\w+/g, ':P') // paramètre Express
    .replace(/\?.*$/, '') // chaîne de requête écrite en dur
    .replace(/\/+$/, '') || '/';

/** Sous-chemins déclarés par un fichier de routeur. */
function sousChemins(fichier) {
  if (!fs.existsSync(fichier)) return [];
  const src = fs.readFileSync(fichier, 'utf8');
  return [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)].map(
    ([, methode, sous]) => ({ methode: methode.toUpperCase(), sous })
  );
}

/** Table des routes montées, reconstruite depuis `app.js`. */
function routesMontees() {
  const app = fs.readFileSync(path.join(RACINE_BACK, 'app.js'), 'utf8');

  const requires = new Map();
  for (const [, nom, rel] of app.matchAll(/const\s+(\w+)\s*=\s*require\('([^']+)'\)/g)) {
    requires.set(nom, rel);
  }

  const table = new Set();

  const ajouter = (prefixe, fichier) => {
    for (const { methode, sous } of sousChemins(fichier)) {
      const complet = (prefixe.replace(/\/$/, '') + sous).replace('/api/v1', '');
      table.add(`${methode} ${gabarit(complet)}`);
    }
  };

  // ── Montages nominatifs ─────────────────────────────────────────────────
  for (const [, prefixe, variable] of app.matchAll(/app\.use\('(\/api\/v1[^']*)',\s*(\w+)\)/g)) {
    const rel = requires.get(variable);
    if (!rel || !rel.includes('route')) continue;
    ajouter(prefixe, path.resolve(RACINE_BACK, rel));
  }

  // ── Montage en BOUCLE des référentiels de type ──────────────────────────
  //
  // Lu depuis la liste qui le nourrit, et non depuis `app.js` : c'est elle qui
  // porte les chemins. Sans ce bloc, les appels du portail vers
  // `/types-document`, `/types-intervenant` et `/types-inspection` seraient
  // tous déclarés orphelins.
  const listeTypes = path.join(RACINE_BACK, 'modules', 'referentiel', 'typesReferentiels.js');
  if (fs.existsSync(listeTypes)) {
    const src = fs.readFileSync(listeTypes, 'utf8');
    const chemins = [...src.matchAll(/chemin:\s*'([^']+)'/g)].map(([, c]) => c);
    // Tous partagent le même routeur générique : on prend celui du premier
    // référentiel déclaré et on le monte sous chacun des chemins.
    const routeurGenerique = path.join(
      RACINE_BACK, 'modules', 'referentiel', 'route', 'referentielType.route.js'
    );
    for (const chemin of chemins) {
      ajouter(`/api/v1${chemin}`, routeurGenerique);
    }
  }

  return table;
}

/** Appels HTTP écrits dans la couche service du portail admin. */
function appelsAdmin() {
  const appels = [];

  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) {
        parcourir(complet);
        continue;
      }
      if (!entree.name.endsWith('.js') || entree.name.endsWith('.test.js')) continue;

      const src = fs.readFileSync(complet, 'utf8');
      for (const [, methode, chemin] of src.matchAll(
        /\bapi\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/g
      )) {
        // Chemin ENTIÈREMENT interpolé : construit par une fabrique (les
        // référentiels génériques), sa valeur n'est pas ici. Rien à confronter.
        if (chemin.startsWith('${')) continue;

        // `/uploads/...` est servi par `express.static` derrière ses gardes, pas
        // par un routeur : il n'apparaît pas dans la table et n'a pas à y être.
        if (chemin.startsWith('/uploads')) continue;

        appels.push({ methode: methode.toUpperCase(), chemin, fichier: entree.name });
      }
    }
  };

  if (adminPresent) parcourir(SERVICES);
  return appels;
}

const decrire = adminPresent ? describe : describe.skip;

decrire('parité des routes portail admin ↔ backend', () => {
  const table = adminPresent ? routesMontees() : new Set();
  const appels = appelsAdmin();

  it('la table des routes est bien reconstruite', () => {
    // Garde-fou du test lui-même : si `app.js` change de style de montage, la
    // table tomberait à zéro et le test suivant passerait pour de mauvaises
    // raisons — il ne comparerait plus rien.
    expect(table.size).toBeGreaterThan(150);
    expect(appels.length).toBeGreaterThan(100);
  });

  it('chaque appel du portail vise une route montée', () => {
    const orphelins = appels
      .filter(({ methode, chemin }) => {
        const complet = chemin.startsWith('/') ? chemin : `/${chemin}`;
        return !table.has(`${methode} ${gabarit(complet)}`);
      })
      .map(({ methode, chemin, fichier }) => `${methode} ${chemin}  (${fichier})`);

    expect([...new Set(orphelins)]).toEqual([]);
  });

  it('les référentiels de type montés en BOUCLE sont bien vus', () => {
    // Le piège que ce test a dû désamorcer : sans lecture du montage en boucle,
    // ces trois-là passaient pour des routes inexistantes.
    expect(table.has('GET /types-document')).toBe(true);
    expect(table.has('GET /types-intervenant/actifs')).toBe(true);
    expect(table.has('PATCH /types-inspection/:P/actif')).toBe(true);
  });
});
