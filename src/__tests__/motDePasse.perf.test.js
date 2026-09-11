'use strict';

/**
 * Tests — le hachage des mots de passe ne gèle pas le serveur.
 *
 * `bcryptjs` (JavaScript pur) occupait le thread principal pendant chaque
 * connexion : 50 connexions simultanées retardaient TOUTES les autres
 * requêtes du worker de plus de cinq secondes (mesure dans utils/motDePasse.js).
 *
 * On vérifie ici :
 *   1. que le module natif est bien celui chargé ;
 *   2. que les empreintes restent compatibles dans les deux sens (aucune
 *      migration des mots de passe existants) ;
 *   3. que la boucle d'événements reste disponible pendant des connexions
 *      simultanées — mesuré RELATIVEMENT à bcryptjs, dans les mêmes
 *      conditions, pour ne pas dépendre de la vitesse de la machine.
 */

const { monitorEventLoopDelay } = require('perf_hooks');
const bcryptjs = require('bcryptjs');
const motDePasse = require('../utils/motDePasse.js');

const MDP = 'MotDePasse#2026';

/** Blocage maximal de la boucle (ms) pendant `n` vérifications simultanées. */
async function blocageMax(lib, empreinte, n) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const resultats = await Promise.all(Array.from({ length: n }, () => lib.compare(MDP, empreinte)));
  h.disable();
  expect(resultats.every(Boolean)).toBe(true);
  return h.max / 1e6;
}

describe('utils/motDePasse', () => {
  it('utilise bcrypt natif', () => {
    expect(motDePasse.implementation).toBe('natif');
  });

  it('vérifie une empreinte produite par bcryptjs (comptes existants)', async () => {
    const ancienne = await bcryptjs.hash(MDP, 4);
    expect(await motDePasse.compare(MDP, ancienne)).toBe(true);
    expect(await motDePasse.compare('mauvais', ancienne)).toBe(false);
  });

  it('produit une empreinte que bcryptjs sait vérifier (retour arrière possible)', async () => {
    const nouvelle = await motDePasse.hash(MDP, 4);
    expect(nouvelle.startsWith('$2b$04$')).toBe(true);
    expect(await bcryptjs.compare(MDP, nouvelle)).toBe(true);
  });

  it('accepte l’empreinte factice d’égalisation du temps de réponse', async () => {
    // auth.service.js compare le mot de passe à ce hash quand le compte
    // n'existe pas, pour ne pas révéler son existence par la durée.
    const DUMMY_HASH = '$2b$12$LmKBP5z6RvWnAnsFOVK9Qeq7C2JKvPAzTq/xz7rJa2Y5m.JnHkTFO';
    expect(await motDePasse.compare(MDP, DUMMY_HASH)).toBe(false);
  });

  it('laisse la boucle d’événements disponible pendant des connexions simultanées', async () => {
    const empreinte = await bcryptjs.hash(MDP, 12);

    const avecJs = await blocageMax(bcryptjs, empreinte, 4);
    const avecNatif = await blocageMax(motDePasse, empreinte, 4);

    // bcryptjs bloque par tranches d'environ 100 ms à 12 tours ; le natif ne
    // bloque presque pas. Comparaison relative : robuste à la machine.
    expect(avecNatif).toBeLessThan(avecJs / 2);
  }, 30000);
});
