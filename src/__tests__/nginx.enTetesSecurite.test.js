'use strict';

/**
 * Tests — en-têtes de sécurité du portail web (deploy/nginx-admin.conf).
 *
 * Le piège verrouillé ici : nginx n'hérite les `add_header` du bloc `server`
 * QUE dans les `location` qui n'en déclarent aucun. `location = /index.html`
 * posait `Cache-Control` — et perdait ainsi CSP, HSTS, X-Frame-Options et
 * nosniff. Comme toute route de l'application est servie par ce bloc
 * (`try_files … /index.html`), la page HTML partait sans aucune protection :
 * la CSP n'était jamais appliquée, et l'application pouvait être encadrée.
 *
 * La configuration nginx n'est exécutée par aucun test d'intégration : sans
 * ce test, un `add_header` ajouté demain dans un bloc `location` rouvrirait la
 * faille sans que rien ne le signale.
 */

const fs = require('fs');
const path = require('path');

const CONF = fs.readFileSync(path.join(__dirname, '../../deploy/nginx-admin.conf'), 'utf8');

const EN_TETES_SECURITE = [
  'Strict-Transport-Security',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Content-Security-Policy',
];

/** Retire les commentaires : seules les directives comptent. */
const sansCommentaires = (texte) => texte
  .split('\n')
  .filter((ligne) => !ligne.trim().startsWith('#'))
  .join('\n');

/** { nom → valeur } des `add_header` d'un fragment de configuration. */
const enTetes = (texte) => {
  const trouves = {};
  for (const [, nom, valeur] of texte.matchAll(/add_header\s+([\w-]+)\s+"([^"]*)"/g)) {
    trouves[nom] = valeur;
  }
  return trouves;
};

const conf = sansCommentaires(CONF);
const MOTIF_LOCATION = /\n\s*location\s+[^{]+\{[^}]*\}/g;
const locations = conf.match(MOTIF_LOCATION) || [];
const niveauServeur = enTetes(conf.replace(MOTIF_LOCATION, ''));

describe('nginx-admin.conf — en-têtes de sécurité', () => {
  test('le niveau `server` déclare les six en-têtes de sécurité', () => {
    for (const nom of EN_TETES_SECURITE) {
      expect(niveauServeur[nom]).toBeTruthy();
    }
  });

  test('tout bloc `location` qui pose un en-tête répète les six, à l’identique', () => {
    const avecEnTete = locations.filter((bloc) => bloc.includes('add_header'));
    // index.html et /assets/ — si ce nombre tombe à 0, le test ne prouve plus rien.
    expect(avecEnTete.length).toBeGreaterThan(0);

    for (const bloc of avecEnTete) {
      const locaux = enTetes(bloc);
      for (const nom of EN_TETES_SECURITE) {
        expect({ bloc: bloc.trim().split('\n')[0], nom, valeur: locaux[nom] })
          .toEqual({ bloc: bloc.trim().split('\n')[0], nom, valeur: niveauServeur[nom] });
      }
    }
  });

  test('la CSP autorise les aperçus `blob:` et interdit les plugins', () => {
    const csp = niveauServeur['Content-Security-Policy'];

    expect(csp).toMatch(/img-src[^;]*\bblob:/);
    expect(csp).toMatch(/frame-src[^;]*\bblob:/);
    expect(csp).toMatch(/media-src[^;]*\bblob:/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  test('la CSP n’autorise jamais de script en ligne ni `eval`', () => {
    const scriptSrc = niveauServeur['Content-Security-Policy'].match(/script-src([^;]*)/)[1];

    expect(scriptSrc).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*(?!\.)/);
  });
});
