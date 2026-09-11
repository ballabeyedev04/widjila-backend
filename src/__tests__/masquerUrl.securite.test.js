'use strict';

/**
 * Tests — aucun jeton secret dans les journaux d'accès.
 *
 * Le lien de partage d'un rapport porte son secret DANS l'URL, et morgan
 * journalisait l'URL en clair : la base n'en garde que l'empreinte, les
 * fichiers de logs en gardaient la valeur. Voir utils/masquerUrl.js.
 */

const fs = require('fs');
const path = require('path');
const masquerUrl = require('../utils/masquerUrl.js');

const JETON = 'Qm9uam91ci1jZWNpLWVzdC11bi1qZXRvbi1kZS0yNTYtYml0cw';

describe('masquerUrl', () => {
  it.each([
    [`/r/${JETON}`, '/r/[masqué]'],
    [`/api/v1/r/${JETON}`, '/api/v1/r/[masqué]'],
    [`/api/v1/r/${JETON}?format=pdf`, '/api/v1/r/[masqué]?format=pdf'],
    [`/api/v1/paytech/payment/status?token=${JETON}`, '/api/v1/paytech/payment/status?token=[masqué]'],
    [`/x?a=1&refreshToken=${JETON}&b=2`, '/x?a=1&refreshToken=[masqué]&b=2'],
  ])('masque le jeton de %s', (url, attendu) => {
    expect(masquerUrl(url)).toBe(attendu);
    expect(masquerUrl(url)).not.toContain(JETON);
  });

  it.each([
    '/api/v1/chantiers/3f2c6b1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f/rapports',
    '/api/v1/reports?page=2&limit=20',
    '/api/v1/admin/utilisateurs?search=diop',
  ])('laisse intacte une URL sans secret (%s)', (url) => {
    expect(masquerUrl(url)).toBe(url);
  });

  it('tolère une valeur absente', () => {
    expect(masquerUrl(undefined)).toBe('');
  });
});

describe('câblage dans app.js', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

  it('le journal d’accès utilise l’URL masquée', () => {
    expect(app).toMatch(/morgan\.token\(\s*'url-masquee'/);
    expect(app).toMatch(/:url-masquee/);
  });

  it('n’utilise plus les formats prédéfinis qui journalisent l’URL brute', () => {
    expect(app).not.toMatch(/morgan\(\s*isProd\s*\?\s*'combined'\s*:\s*'dev'/);
  });
});
