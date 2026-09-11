'use strict';

/**
 * Tests — cache applicatif (utils/cache.js) sans Redis.
 *
 * Sans `REDIS_URL`, le cache était un no-op : le tableau de bord — requête la
 * plus lourde du produit — était recalculé à chaque ouverture sur un
 * déploiement mono-process. Le repli mémoire doit rester BORNÉ (pas de fuite
 * mémoire sous charge) et respecter son TTL.
 */

const cache = require('../utils/cache.js');

beforeEach(() => cache._memoire.vider());
afterEach(() => jest.useRealTimers());

describe('repli mémoire', () => {
  it('rend ce qui a été écrit', async () => {
    await cache.ecrire('dashboard:org-1', { chantiers: 3 });

    expect(await cache.lire('dashboard:org-1')).toEqual({ chantiers: 3 });
  });

  it('expire au bout du TTL', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-12T08:00:00Z') });
    await cache.ecrire('cle', 1, 45);

    jest.advanceTimersByTime(44_000);
    expect(await cache.lire('cle')).toBe(1);
    jest.advanceTimersByTime(2_000);
    expect(await cache.lire('cle')).toBeNull();
  });

  it('reste borné : 10 000 écritures ne gardent pas plus que le plafond', async () => {
    for (let i = 0; i < 10_000; i += 1) await cache.ecrire(`cle:${i}`, i);

    expect(cache._memoire.taille()).toBe(cache._memoire.MAX_ENTREES_MEMOIRE);
    // Les plus récentes restent, les plus anciennes sont sorties.
    expect(await cache.lire('cle:9999')).toBe(9999);
    expect(await cache.lire('cle:0')).toBeNull();
  });

  it('invalide par motif', async () => {
    await cache.ecrire('dashboard:stats-globales:org-1', 1);
    await cache.ecrire('dashboard:stats-globales:org-2', 2);
    await cache.ecrire('autre:org-1', 3);

    await cache.invalider('dashboard:*:org-1');

    expect(await cache.lire('dashboard:stats-globales:org-1')).toBeNull();
    expect(await cache.lire('dashboard:stats-globales:org-2')).toBe(2);
    expect(await cache.lire('autre:org-1')).toBe(3);
  });
});

describe('volUnique', () => {
  it('des appels simultanés partagent un calcul', async () => {
    const calcul = jest.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return 42; });

    const resultats = await Promise.all(Array.from({ length: 100 }, () => cache.volUnique('k', calcul)));

    expect(calcul).toHaveBeenCalledTimes(1);
    expect(resultats.every((r) => r === 42)).toBe(true);
  });

  it('un échec est partagé puis oublié : l’appel suivant recalcule', async () => {
    const calcul = jest.fn()
      .mockRejectedValueOnce(new Error('base indisponible'))
      .mockResolvedValueOnce('ok');

    const [a, b] = await Promise.allSettled([cache.volUnique('k2', calcul), cache.volUnique('k2', calcul)]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');

    await expect(cache.volUnique('k2', calcul)).resolves.toBe('ok');
    expect(calcul).toHaveBeenCalledTimes(2);
  });

  it('des clés différentes ne se bloquent pas', async () => {
    const calcul = jest.fn(async (v) => v);

    await Promise.all([cache.volUnique('a', () => calcul('a')), cache.volUnique('b', () => calcul('b'))]);

    expect(calcul).toHaveBeenCalledTimes(2);
  });
});
