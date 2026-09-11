'use strict';

/**
 * Toute route montée exige-t-elle une authentification ?
 *
 * ## Le défaut que ce test rend impossible
 *
 * Ajouter une route est une ligne. Oublier `auth` dans cette ligne en est une
 * autre — et rien ne le signale : la route répond, les tests métier passent,
 * l'application fonctionne. Elle est simplement ouverte à tout le monde.
 *
 * C'est la faute la plus coûteuse du projet et la plus facile à commettre,
 * parce qu'elle ne produit AUCUN symptôme. Un test qui relit la table des
 * routes est le seul filet qui la voie.
 *
 * ## Pourquoi lire le TEXTE des fichiers de routes
 *
 * Express n'expose pas de façon stable le nom des middlewares empilés sur une
 * couche. Inspecter le routeur à l'exécution donnerait une liste de fonctions
 * anonymes, sans moyen de dire laquelle est `auth`.
 *
 * Le projet, lui, écrit ses routes de deux façons — le middleware passé
 * directement, ou une constante `gardes` diffusée par `...gardes`. Les deux
 * sont reconnues ici.
 *
 * ## Les routes publiques
 *
 * Elles sont listées nommément, avec leur raison. Une route publique n'est
 * pas un oubli : c'est une décision, et elle doit s'écrire comme telle.
 */

const fs = require('fs');
const path = require('path');

const MODULES = path.resolve(__dirname, '..', 'modules');

/**
 * Routes accessibles SANS jeton — chacune pour une raison explicite.
 *
 * Le format est `<fichier de routes>::<chemin déclaré>` : deux modules
 * peuvent déclarer `/` sans que l'exemption de l'un vaille pour l'autre.
 */
const PUBLIQUES = new Map([
  // ── Entrer dans l'application ────────────────────────────────────────────
  ['auth.route.js::/login', 'point d’entrée : aucun jeton à présenter encore'],
  ['auth.route.js::/register', 'création de compte'],
  ['auth.route.js::/refresh', 'renouvellement : le jeton d’accès est justement expiré'],
  ['auth.route.js::/mfa-verify', 'seconde étape, portée par un jeton temporaire propre'],
  ['auth.route.js::/logout', 'doit aboutir même si le jeton est déjà périmé'],

  // ── Reprendre la main sur un compte ──────────────────────────────────────
  ['account.route.js::/forgot-password', 'parcours de secours : par définition sans session'],
  ['account.route.js::/reset-password', 'idem, porté par le code reçu par courriel'],

  // ── Lu avant toute connexion ─────────────────────────────────────────────
  ['referentiel.route.js::/pays',
    'catalogue des pays du formulaire d’inscription : lu avant d’avoir un compte'],
  ['subscription.route.js::/plans',
    'grille tarifaire : reste lisible quand l’essai est terminé, donc précisément '
    + 'quand le client en a besoin'],

  // ── Imposées par une plateforme ──────────────────────────────────────────
  ['suppressionCompte.route.js::/',
    'exigence Google Play : l’URL de demande de suppression de compte doit '
    + 'être joignable sans connexion ET sans l’application installée. '
    + 'Compensée par le seuil de débit le plus strict du projet, la route '
    + 'étant ouverte à Internet et déclenchant un envoi de courriel'],

  // ── Appelées par un serveur, pas par un utilisateur ──────────────────────
  ['subscription.route.js::/webhook',
    'appelé par Stripe : authentifié par SIGNATURE, pas par jeton'],
  ['paytech.route.js::/ipn',
    'notification du prestataire : authentifiée par signature'],

  // ── Portées par un JETON SECRET, pas par un identifiant ──────────────────
  ['reports.route.js::/r/:token',
    'lien de partage d’un rapport (cahier des charges Rapports § 14) : '
    + '« widjila.app/r/{token} » doit s’ouvrir sans compte chez le destinataire. '
    + 'Le paramètre est un jeton de 256 bits, dont seule l’empreinte est stockée, '
    + 'révocable et éventuellement expirant — il ne se parcourt pas comme un '
    + 'identifiant. Chaque ouverture est journalisée'],
]);

/**
 * Seul paramètre toléré sur une route publique : un JETON secret.
 *
 * La règle « aucune route publique paramétrée » vise les identifiants, qui
 * se parcourent en les incrémentant. Un jeton aléatoire de 256 bits ne se
 * parcourt pas ; il reste nommé `:token` pour que l'exception se lise.
 */
const PARAMETRE_JETON = /\/:token$/;

/** Les fichiers de routes du projet. */
function fichiersDeRoutes(dossier = MODULES, acc = []) {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) fichiersDeRoutes(complet, acc);
    else if (entree.name.endsWith('.route.js')) acc.push(complet);
  }
  return acc;
}

/**
 * Les routes déclarées dans un fichier, avec la chaîne de middlewares écrite
 * entre le chemin et le contrôleur.
 */
function routesDe(fichier) {
  const src = fs.readFileSync(fichier, 'utf8');
  const nom = path.basename(fichier);

  // Une constante `gardes` (ou `gardesAdmin`…) contenant `auth` vaut
  // authentification pour toute route qui la diffuse.
  const gardesAvecAuth = new Set();
  for (const [, nomConst, contenu] of src.matchAll(
    /const\s+(\w*[Gg]ardes\w*)\s*=\s*\[([^\]]*)\]/g
  )) {
    if (/\bauth\b/.test(contenu)) gardesAvecAuth.add(nomConst);
  }

  const routes = [];
  for (const [, methode, chemin, chaine] of src.matchAll(
    /router\.(get|post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)\);/g
  )) {
    const direct = /(^|[\s,(])auth([\s,)]|$)/.test(chaine);
    const parGardes = [...gardesAvecAuth].some((g) =>
      new RegExp(`\\.\\.\\.${g}\\b`).test(chaine)
    );
    routes.push({
      fichier: nom,
      cle: `${nom}::${chemin}`,
      libelle: `${methode.toUpperCase()} ${chemin}  (${nom})`,
      authentifiee: direct || parGardes,
    });
  }
  return routes;
}

const toutes = fichiersDeRoutes().flatMap(routesDe);

describe('authentification des routes', () => {
  it('la table des routes est bien reconstruite', () => {
    // Garde-fou du test : si l'écriture des routes change, la table
    // tomberait à zéro et l'assertion suivante passerait pour de mauvaises
    // raisons — elle ne vérifierait plus rien.
    expect(toutes.length).toBeGreaterThan(150);
  });

  it('chaque route exige un jeton, sauf celles listées comme publiques', () => {
    const ouvertes = toutes
      .filter((r) => !r.authentifiee && !PUBLIQUES.has(r.cle))
      .map((r) => r.libelle);

    expect(ouvertes).toEqual([]);
  });

  it('la liste des routes publiques ne contient rien de périmé', () => {
    // Une exemption qui ne correspond plus à aucune route est un vestige :
    // elle laisse croire qu'une décision a été prise là où il n'y a plus
    // rien, et masquerait une future route homonyme.
    const declarees = new Set(toutes.map((r) => r.cle));
    const orphelines = [...PUBLIQUES.keys()].filter((c) => !declarees.has(c));

    expect(orphelines).toEqual([]);
  });

  it('aucune route publique ne porte d’identifiant de ressource', () => {
    // Une route publique paramétrée (`/trucs/:id`) se parcourt en
    // incrémentant l'identifiant. Si une telle route devenait nécessaire,
    // elle mériterait sa propre discussion plutôt qu'une ligne de plus dans
    // la liste ci-dessus.
    const parametrees = [...PUBLIQUES.keys()]
      .filter((c) => c.includes('/:') && !PARAMETRE_JETON.test(c));

    expect(parametrees).toEqual([]);
  });
});
