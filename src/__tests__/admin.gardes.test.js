'use strict';

/**
 * Tests — pile de gardes des routes d'administration plateforme.
 *
 * L'espace `/admin/*` est le plus sensible du produit : le super-admin y voit
 * et modifie TOUTES les organisations clientes, leurs utilisateurs, leurs
 * données personnelles, leurs paiements et les prix de vente. Il traverse
 * `checkOrganisation` sans aucun filtre de cloisonnement.
 *
 * ── Pourquoi ce test lit le SOURCE des routeurs ───────────────────────────
 * Une garde oubliée sur une route d'administration ne casse rien de visible :
 * la route fonctionne, elle est simplement moins protégée. Elle ne se
 * découvre qu'en relisant le fichier — ou lors d'un incident. Ce test rend
 * l'oubli impossible à ignorer.
 *
 * C'est ainsi qu'a été trouvée l'incohérence des deux routeurs d'abonnement :
 * seuls de tout `/admin/*` à ne porter ni MFA ni limitation de débit, alors
 * qu'ils permettent de modifier un prix et d'accorder gratuitement une
 * formule payante.
 *
 * ── Ce que le test NE prouve pas ──────────────────────────────────────────
 * Que les gardes fonctionnent — c'est le rôle des tests de chaque middleware.
 * Il prouve seulement qu'elles sont POSÉES, ce qui est l'erreur réellement
 * commise en pratique.
 */

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');

/**
 * Routeurs montés sous `/api/v1/admin/*`, lus dans `app.js` plutôt que
 * listés à la main : un routeur admin ajouté demain entre automatiquement
 * dans le périmètre du test.
 */
function routeursAdmin() {
  const app = fs.readFileSync(path.join(RACINE, 'app.js'), 'utf8');

  // 1. les montages `/api/v1/admin/...` et la variable de routeur employée
  const montages = [...app.matchAll(/app\.use\(\s*'\/api\/v1\/admin\/[^']*'\s*,\s*(\w+)\s*\)/g)]
    .map(([, variable]) => variable);

  // 2. le `require` correspondant, pour remonter au fichier
  return montages.map((variable) => {
    const motif = new RegExp(`const\\s+${variable}\\s*=\\s*require\\('\\.([^']+)'\\)`);
    const trouve = app.match(motif);
    if (!trouve) throw new Error(`Routeur ${variable} monté mais introuvable dans les require`);
    return { variable, chemin: path.join(RACINE, trouve[1]) };
  });
}

const ROUTEURS = routeursAdmin();

/** Gardes attendues sur CHAQUE route d'administration. */
const GARDES = [
  ['auth', /\bauth\b/],
  ['checkActiveUser', /checkActiveUser/],
  ["requireRole('Admin')", /requireRole\('Admin'\)/],
  ['requireMfaActive', /requireMfaActive/],
  ['adminRateLimit', /adminRateLimit/],
];

describe('périmètre', () => {
  it('trouve les routeurs montés sous /api/v1/admin', () => {
    // Si ce compte tombe à zéro, le test ne vérifie plus rien : il passerait
    // en silence alors que l'administration serait entièrement dégardée.
    expect(ROUTEURS.length).toBeGreaterThanOrEqual(6);
  });

  it('chaque routeur monté existe sur le disque', () => {
    for (const { variable, chemin } of ROUTEURS) {
      expect(fs.existsSync(chemin)).toBe(true);
      expect(variable).toBeTruthy();
    }
  });
});

/**
 * Corps du fichier SANS ses lignes d'import.
 *
 * Compter les gardes sur le fichier entier rendait le test faux : retirer
 * toutes les utilisations d'un middleware tout en gardant son `require` le
 * laissait passer. C'est l'usage qui protège, pas l'import.
 */
function corpsSansImports(source) {
  return source
    .split('\n')
    .filter((ligne) => !/^\s*(const|let|var)\s.*=\s*require\(/.test(ligne))
    .join('\n');
}

describe('pile de gardes', () => {
  for (const { chemin } of ROUTEURS) {
    const nom = path.basename(chemin);
    const source = fs.readFileSync(chemin, 'utf8');
    const corps = corpsSansImports(source);

    // Un routeur déclare ses gardes soit en ligne sur chaque route, soit une
    // fois dans un tableau `gardes` étalé ensuite (`...gardes`). Les deux
    // formes sont légitimes ; le nombre d'usages attendus en dépend.
    const gardesGroupees = /const\s+gardes\s*=\s*\[/.test(source);
    const nbRoutes = (source.match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
    const attendu = gardesGroupees ? 1 : nbRoutes;

    describe(nom, () => {
      it('déclare au moins une route', () => {
        expect(nbRoutes).toBeGreaterThan(0);
      });

      it.each(GARDES)('applique %s à chaque route', (libelle, motif) => {
        const global = new RegExp(motif.source, 'g');
        const usages = (corps.match(global) || []).length;
        expect(usages).toBeGreaterThanOrEqual(attendu);
        expect(libelle).toBeTruthy();
      });

      it('étale bien le tableau de gardes sur toutes les routes', () => {
        if (!gardesGroupees) return;
        // Une route qui oublierait `...gardes` serait servie sans aucune
        // garde — le cas le plus grave, et le plus facile à commettre.
        const nbEtalements = (source.match(/\.\.\.gardes/g) || []).length;
        expect(nbEtalements).toBe(nbRoutes);
      });
    });
  }
});

describe('aucune route d’administration hors périmètre', () => {
  it('les modules d’abonnement admin sont bien couverts', () => {
    // Régression réelle : ces deux routeurs — modification des PRIX et
    // activation MANUELLE d'un abonnement — étaient les seuls de tout
    // `/admin/*` sans MFA ni limitation de débit.
    const noms = ROUTEURS.map((r) => path.basename(r.chemin));
    expect(noms).toContain('planAbonnement.route.js');
    expect(noms).toContain('abonnementAdmin.route.js');
  });
});
