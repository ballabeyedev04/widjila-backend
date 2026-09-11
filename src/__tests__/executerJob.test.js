'use strict';

/**
 * Tests — exécution des tâches planifiées (utils/executerJob.js).
 *
 * Défauts couverts :
 *   - un échec de job était journalisé SANS son motif (second argument de
 *     winston perdu) et sans compteur : une panne nocturne restait muette ;
 *   - un worker tué pendant un job ne laissait aucune trace ;
 *   - une coupure de base de quelques secondes faisait sauter le passage du
 *     jour, sans nouvelle tentative ;
 *   - un passage manqué (serveur arrêté à l'heure du cron) était perdu ;
 *   - deux instances exécutaient chacune chaque job.
 */

const { ConnectionAcquireTimeoutError } = require('sequelize');

/** Module neuf : le registre des jobs est propre à chaque test. */
function charger() {
  const m = {};
  jest.isolateModules(() => {
    m.executerJob = require('../utils/executerJob.js');
    m.metrics = require('../utils/metrics.js');
    m.logger = require('../utils/logger.js');
    m.contexte = require('../utils/requestContext.js');
    // Chargé d'avance : `estErreurTransitoire` le requiert à la première
    // erreur, et Sequelize pose un minuteur à son chargement — il serait
    // compté par les faux minuteurs comme une reprise.
    require('../middlewares/errorHandler.middleware.js');
  });
  for (const niveau of ['info', 'warn', 'error']) jest.spyOn(m.logger, niveau).mockImplementation(() => m.logger);
  return m;
}

function doublures() {
  return {
    journal: {
      debut: jest.fn().mockResolvedValue('hist-1'),
      fin: jest.fn().mockResolvedValue(),
      marquerInterrompus: jest.fn().mockResolvedValue(0),
      dernierSucces: jest.fn().mockResolvedValue(null),
      purgerAnciens: jest.fn().mockResolvedValue(0),
    },
    verrou: jest.fn(async (nom, fn) => ({ verrouObtenu: true, resultat: await fn() })),
  };
}

const passagere = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

afterEach(() => jest.useRealTimers());

it('succès : historique, journal et métriques renseignés', async () => {
  const { executerJob, metrics } = charger();
  const { journal, verrou } = doublures();
  const job = executerJob.envelopperJob('j-succes', async () => ({ traitees: 3 }), { journal, verrou });

  const r = await job();

  expect(r).toEqual({ statut: 'succes', resultat: { traitees: 3 } });
  expect(journal.debut).toHaveBeenCalledWith('j-succes', 1);
  expect(journal.fin).toHaveBeenCalledWith('hist-1', expect.objectContaining({ statut: 'succes', resultat: { traitees: 3 } }));
  expect(metrics.instantane().jobs['j-succes']).toMatchObject({ executions: 1, echecs: 0 });
  expect(metrics.instantane().jobs['j-succes'].dernierSucces).toEqual(expect.any(String));
});

it('échec définitif : jamais levé vers node-cron, motif ET pile journalisés, aucune reprise', async () => {
  const { executerJob, metrics, logger } = charger();
  jest.useFakeTimers();
  const { journal, verrou } = doublures();
  const job = executerJob.envelopperJob('j-bug', async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); }, { journal, verrou });

  const r = await job();

  expect(r.statut).toBe('echec');
  const [message, meta] = logger.error.mock.calls[0];
  expect(message).toContain("Cannot read properties of undefined (reading 'id')");
  expect(meta.stack).toContain('TypeError');
  expect(journal.fin).toHaveBeenCalledWith('hist-1', expect.objectContaining({ statut: 'echec' }));
  expect(metrics.instantane().jobs['j-bug'].echecs).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('erreur passagère : nouvelle tentative différée, qui réussit', async () => {
  const { executerJob, metrics } = charger();
  jest.useFakeTimers();
  const { journal, verrou } = doublures();
  const tache = jest.fn()
    .mockRejectedValueOnce(new ConnectionAcquireTimeoutError(new Error('Operation timeout')))
    .mockResolvedValueOnce({ ok: true });
  const job = executerJob.envelopperJob('j-reprise', tache, { journal, verrou, delaiBaseRepriseMs: 1000 });

  expect((await job()).statut).toBe('echec');
  expect(jest.getTimerCount()).toBe(1);

  await jest.advanceTimersByTimeAsync(1600);

  expect(tache).toHaveBeenCalledTimes(2);
  expect(journal.debut).toHaveBeenLastCalledWith('j-reprise', 2);
  expect(metrics.instantane().jobs['j-reprise']).toMatchObject({ executions: 2, echecs: 1 });
});

it('erreur passagère persistante : abandon après le nombre maximal de tentatives', async () => {
  const { executerJob, metrics, logger } = charger();
  jest.useFakeTimers();
  const { journal, verrou } = doublures();
  const tache = jest.fn().mockRejectedValue(passagere());
  const job = executerJob.envelopperJob('j-abandon', tache, { journal, verrou, delaiBaseRepriseMs: 1000, maxTentatives: 3 });

  await job();
  await jest.advanceTimersByTimeAsync(1600); // tentative 2
  await jest.advanceTimersByTimeAsync(3100); // tentative 3
  await jest.advanceTimersByTimeAsync(60_000);

  expect(tache).toHaveBeenCalledTimes(3);
  expect(metrics.instantane().compteurs['job.abandon.j-abandon']).toBe(1);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('abandon après 3 tentative'), expect.any(Object));
  expect(jest.getTimerCount()).toBe(0);
});

it('une exécution ne s’empile pas sur la précédente', async () => {
  const { executerJob } = charger();
  const { journal, verrou } = doublures();
  let liberer;
  const job = executerJob.envelopperJob('j-lent', () => new Promise((r) => { liberer = r; }), { journal, verrou });

  const premiere = job();
  await new Promise((r) => setImmediate(r));
  const seconde = await job();
  liberer('fini');

  expect(seconde.statut).toBe('ignore');
  expect((await premiere).statut).toBe('succes');
});

it('verrou détenu par une autre instance : exécution ignorée, rien d’écrit', async () => {
  const { executerJob } = charger();
  const { journal } = doublures();
  const tache = jest.fn();
  const job = executerJob.envelopperJob('j-ailleurs', tache, { journal, verrou: async () => ({ verrouObtenu: false }) });

  expect((await job()).statut).toBe('ignore');
  expect(tache).not.toHaveBeenCalled();
  expect(journal.debut).not.toHaveBeenCalled();
});

it('historique indisponible : le job s’exécute quand même, l’incident est compté', async () => {
  const { executerJob, metrics } = charger();
  const { journal, verrou } = doublures();
  journal.debut.mockRejectedValue(new Error('relation "job_executions" does not exist'));
  const job = executerJob.envelopperJob('j-sans-historique', async () => 'fait', { journal, verrou });

  expect((await job()).statut).toBe('succes');
  expect(metrics.instantane().compteurs['job.historique_indisponible']).toBe(1);
});

it('les lignes écrites pendant le job portent un identifiant d’exécution', async () => {
  const { executerJob, contexte } = charger();
  const { journal, verrou } = doublures();
  const job = executerJob.envelopperJob('j-ctx', async () => contexte.contexteCourant(), { journal, verrou });

  const { resultat } = await job();

  expect(resultat).toMatchObject({ job: 'j-ctx', requestId: expect.stringMatching(/^job-j-ctx-/) });
});

describe('reprise au démarrage', () => {
  it('marque « interrompu » les exécutions laissées en cours et rattrape un passage manqué', async () => {
    const { executerJob, logger } = charger();
    const { journal, verrou } = doublures();
    journal.marquerInterrompus.mockResolvedValue(2);
    journal.dernierSucces.mockResolvedValue(new Date(Date.now() - 3 * 86_400_000));
    const tache = jest.fn().mockResolvedValue('rattrapé');
    executerJob.envelopperJob('j-quotidien', tache, { journal, verrou, periodeMs: 86_400_000, rattrapage: true });

    await executerJob.reprendreApresDemarrage();
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 exécution(s) interrompue(s)'), expect.any(Object));
    expect(tache).toHaveBeenCalledTimes(1);
    expect(journal.purgerAnciens).toHaveBeenCalled();
  });

  it('ne rattrape ni un job sans historique, ni un job à l’heure, ni un job sans rattrapage', async () => {
    const { executerJob } = charger();
    const a = doublures();
    const b = doublures();
    const c = doublures();
    b.journal.dernierSucces.mockResolvedValue(new Date(Date.now() - 3600_000));
    c.journal.dernierSucces.mockResolvedValue(new Date(Date.now() - 10 * 86_400_000));
    const taches = [jest.fn(), jest.fn(), jest.fn()];
    executerJob.envelopperJob('j-neuf', taches[0], { ...a, periodeMs: 86_400_000, rattrapage: true });
    executerJob.envelopperJob('j-a-l-heure', taches[1], { ...b, periodeMs: 86_400_000, rattrapage: true });
    executerJob.envelopperJob('j-rappels', taches[2], { ...c, periodeMs: 86_400_000, rattrapage: false });

    await executerJob.reprendreApresDemarrage();
    await new Promise((r) => setImmediate(r));

    for (const t of taches) expect(t).not.toHaveBeenCalled();
  });
});

describe('estErreurTransitoire', () => {
  const { estErreurTransitoire } = require('../utils/executerJob.js');
  const { ServiceIndisponibleError, ValidationError } = require('../errors/AppError.js');

  it.each([
    ['service externe indisponible', new ServiceIndisponibleError(), true],
    ['connexion refusée', passagere(), true],
    ['pool épuisé', new ConnectionAcquireTimeoutError(new Error('timeout')), true],
    ['bug', new TypeError('x is not a function'), false],
    ['donnée invalide', new ValidationError(), false],
  ])('%s → %s', (_, err, attendu) => {
    expect(estErreurTransitoire(err)).toBe(attendu);
  });
});
