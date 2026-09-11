'use strict';

/**
 * Tests — job « réserves en retard » (logique, sans base).
 * La requête SQL réelle est vérifiée par integration/metier.integration.test.js.
 */

jest.mock('../models/index.js', () => ({ ReserveHistorique: { bulkCreate: jest.fn() } }));
jest.mock('../modules/notification/service/notification.service.js', () => ({ notifier: jest.fn() }));
jest.mock('../utils/executerJob.js', () => ({ envelopperJob: (nom, fn) => fn }));

const sequelize = require('../config/db.js');
const { ReserveHistorique } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const { marquerReservesEnRetard, aujourdhui, STATUTS_ELIGIBLES } = require('../jobs/markReservesEnRetard.job.js');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(sequelize, 'transaction').mockImplementation(async (fn) => fn({}));
});

describe('marquerReservesEnRetard', () => {
  it('n’écrase JAMAIS un travail déclaré fait (corrigee, a_verifier) ni un verdict', () => {
    for (const s of ['corrigee', 'a_verifier', 'validee', 'refusee', 'cloturee', 'en_retard']) {
      expect(STATUTS_ELIGIBLES).not.toContain(s);
    }
  });

  it('compare à la date du JOUR dans le fuseau des échéances (échéance du jour = pas encore en retard)', async () => {
    const query = jest.spyOn(sequelize, 'query').mockResolvedValue([]);
    const maintenant = new Date('2026-09-10T21:30:00Z'); // 23h30 à Paris : on est encore le 10

    await marquerReservesEnRetard({ maintenant });

    const [sql, options] = query.mock.calls[0];
    expect(sql).toMatch(/date_limite < :jour/);
    expect(options.replacements.jour).toBe('2026-09-10');
    expect(options.replacements.eligibles).toEqual(STATUTS_ELIGIBLES);
  });

  it('historise chaque réserve marquée et ne notifie QUE les lignes réellement modifiées', async () => {
    jest.spyOn(sequelize, 'query').mockResolvedValue([
      { id: 'r1', numero: 'R-1', titre: 'Fuite', assigneA: 'u-ent', creePar: 'u-chef', ancienStatut: 'en_cours' },
    ]);

    const res = await marquerReservesEnRetard();

    expect(res).toEqual({ reserves: 1 });
    const lignes = ReserveHistorique.bulkCreate.mock.calls[0][0];
    expect(lignes).toEqual([expect.objectContaining({
      reserveId: 'r1', action: 'statut', anciennes_valeurs: { statut: 'en_cours' },
    })]);
    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifier.mock.calls[0][0].utilisateurId).toBe('u-ent');
  });

  it('rien à marquer : aucune écriture d’historique, aucune notification', async () => {
    jest.spyOn(sequelize, 'query').mockResolvedValue([]);
    expect(await marquerReservesEnRetard()).toEqual({ reserves: 0 });
    expect(ReserveHistorique.bulkCreate).not.toHaveBeenCalled();
    expect(NotificationService.notifier).not.toHaveBeenCalled();
  });

  it('une erreur de base REMONTE (l’enveloppe du job la journalise et la retente)', async () => {
    jest.spyOn(sequelize, 'query').mockRejectedValue(new Error('connexion perdue'));
    await expect(marquerReservesEnRetard()).rejects.toThrow('connexion perdue');
  });
});

describe('aujourdhui', () => {
  it('suit le fuseau demandé', () => {
    const instant = new Date('2026-12-31T23:30:00Z');
    expect(aujourdhui('Europe/Paris', instant)).toBe('2027-01-01');
    expect(aujourdhui('UTC', instant)).toBe('2026-12-31');
  });
});
