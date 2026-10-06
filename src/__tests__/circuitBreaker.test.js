'use strict';

/**
 * Tests — délai et disjoncteur des services externes (utils/circuitBreaker.js).
 *
 * Scénario de référence : le fournisseur externe est EN PANNE et 100
 * utilisateurs déclenchent un envoi. Sans disjoncteur, chaque requête reste
 * accrochée jusqu'au délai réseau, vague après vague. Avec : la première
 * vague paie le délai, les suivantes échouent immédiatement sans même
 * solliciter le fournisseur.
 */

const { Disjoncteur, avecDelai } = require('../utils/circuitBreaker.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const jamais = () => new Promise(() => {});

beforeEach(() => {
  metrics.reinitialiser();
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
});

describe('avecDelai', () => {
  it('rejette en 503 DELAI_DEPASSE une promesse qui ne se règle jamais', async () => {
    const debut = Date.now();
    const err = await avecDelai(jamais(), 30, 'de test').catch((e) => e);

    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('DELAI_DEPASSE');
    expect(Date.now() - debut).toBeLessThan(500);
  });

  it('laisse passer la valeur d’une promesse rapide', async () => {
    await expect(avecDelai(Promise.resolve(42), 1000, 'de test')).resolves.toBe(42);
  });
});

describe('Disjoncteur', () => {
  it('s’ouvre après le seuil d’échecs consécutifs et n’appelle plus le service', async () => {
    const d = new Disjoncteur('t-ouverture', { seuilEchecs: 3, dureeOuvertureMs: 10_000, delaiAppelMs: 1000 });
    const appel = jest.fn().mockRejectedValue(new Error('502 amont'));

    for (let i = 0; i < 3; i += 1) await expect(d.executer(appel)).rejects.toThrow('502 amont');
    const err = await d.executer(appel).catch((e) => e);

    expect(err.code).toBe('SERVICE_EXTERNE_INDISPONIBLE');
    expect(err.statusCode).toBe(503);
    expect(err.details.reessayerDansS).toBeGreaterThan(0);
    expect(appel).toHaveBeenCalledTimes(3);
    const dep = metrics.instantane().dependances['t-ouverture'];
    expect(dep).toMatchObject({ echecs: 3, rejetsCircuit: 1, circuit: 'ouvert' });
    expect(logger.error).toHaveBeenCalledTimes(1); // une alerte par ouverture, pas une par appel
  });

  it('un refus de la REQUÊTE (adresse invalide) ne compte pas comme une panne', async () => {
    const d = new Disjoncteur('t-client', {
      seuilEchecs: 2, estEchecDependance: (e) => !e.faute_client,
    });
    const appel = jest.fn().mockRejectedValue(Object.assign(new Error('adresse refusée'), { faute_client: true }));

    for (let i = 0; i < 10; i += 1) await d.executer(appel).catch(() => {});

    expect(appel).toHaveBeenCalledTimes(10);
    expect(d.etatCourant().etat).toBe('ferme');
  });

  it('demi-ouvert : un seul appel d’essai à la fois, et le succès referme le circuit', async () => {
    const d = new Disjoncteur('t-essai', { seuilEchecs: 1, dureeOuvertureMs: 30 });
    await d.executer(() => Promise.reject(new Error('panne'))).catch(() => {});
    await attendre(40);

    const appel = jest.fn(async () => { await attendre(20); return 'ok'; });
    const resultats = await Promise.allSettled([d.executer(appel), d.executer(appel), d.executer(appel)]);

    expect(appel).toHaveBeenCalledTimes(1);
    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(d.etatCourant().etat).toBe('ferme');
    await expect(d.executer(() => Promise.resolve('reprise'))).resolves.toBe('reprise');
  });

  it('demi-ouvert : un nouvel échec rouvre le circuit', async () => {
    const d = new Disjoncteur('t-rechute', { seuilEchecs: 1, dureeOuvertureMs: 30 });
    await d.executer(() => Promise.reject(new Error('panne'))).catch(() => {});
    await attendre(40);

    await d.executer(() => Promise.reject(new Error('toujours en panne'))).catch(() => {});

    expect(d.etatCourant().etat).toBe('ouvert');
  });

  it('service externe en panne × 100 utilisateurs : seule la première vague attend', async () => {
    const d = new Disjoncteur('t-100', { seuilEchecs: 5, dureeOuvertureMs: 10_000, delaiAppelMs: 50 });
    const appel = jest.fn(jamais);

    // Première vague : les 100 appels sont tous PARTIS avant que le premier
    // ne tombe en délai. Ils attendent donc ensemble, et non l'un après
    // l'autre — sérialisés, le 100ᵉ ne serait lancé qu'après 99 délais.
    const enVol = Array.from({ length: 100 }, () => d.executer(appel));
    await null; // un tour de micro-tâches : le temps que les 100 appels démarrent
    expect(appel).toHaveBeenCalledTimes(100);

    const vague1 = await Promise.allSettled(enVol);
    expect(vague1.every((r) => r.status === 'rejected' && r.reason.code === 'DELAI_DEPASSE')).toBe(true);

    // Seconde vague, circuit ouvert : servie SANS horloge. Les minuteurs sont
    // gelés ici, donc si un seul de ces 100 appels attendait le délai ou le
    // fournisseur, rien ne se réglerait et le test expirerait.
    jest.useFakeTimers();
    let vague2;
    try {
      vague2 = await Promise.allSettled(Array.from({ length: 100 }, () => d.executer(appel)));
    } finally {
      jest.useRealTimers();
    }

    expect(vague2.every((r) => r.status === 'rejected' && r.reason.code === 'SERVICE_EXTERNE_INDISPONIBLE')).toBe(true);
    expect(appel).toHaveBeenCalledTimes(100); // la seconde vague n'a pas touché le fournisseur
    expect(metrics.instantane().dependances['t-100']).toMatchObject({
      echecs: 100, rejetsCircuit: 100, circuit: 'ouvert',
    });
  });
});
