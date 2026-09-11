'use strict';

/**
 * Tests — les jobs « nettoyage des jetons » et « relances d'échéance ».
 *
 * Ils avalaient leurs erreurs dans un `try/catch` local (le second en ne
 * gardant que `err.message`, pile perdue). Depuis qu'ils sont enveloppés par
 * `utils/executerJob.js#envelopperJob`, c'est l'enveloppe qui journalise,
 * compte et historise l'échec (table `job_executions`) — à condition que le
 * job le LAISSE REMONTER. Un job qui avale son erreur serait enregistré
 * « succès » alors qu'il n'a rien fait.
 */

jest.mock('../models/index.js', () => ({
  RefreshToken: { destroy: jest.fn() },
  UserOtp: { destroy: jest.fn() },
  Reserve: { findAll: jest.fn() },
  Chantier: {},
  Utilisateur: {},
}));
// L'enveloppe est testée à part (executerJob.test.js) : ici, elle rend le job tel quel.
jest.mock('../utils/executerJob.js', () => ({ envelopperJob: jest.fn((_nom, job) => job) }));
jest.mock('../modules/notification/service/notification.service.js', () => ({
  dejaNotifie: jest.fn(),
  notifier: jest.fn(),
}));

const { Op } = require('sequelize');
const { RefreshToken, UserOtp, Reserve } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const { cleanupExpiredTokens } = require('../jobs/cleanupExpiredTokens.job.js');
const { relancerEcheances } = require('../jobs/reminders.job.js');

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.dejaNotifie.mockResolvedValue(false);
  NotificationService.notifier.mockResolvedValue(undefined);
});

describe('nettoyage des jetons expirés', () => {
  it('rend son BILAN — il est historisé par l’enveloppe', async () => {
    RefreshToken.destroy.mockResolvedValue(12);
    UserOtp.destroy.mockResolvedValue(3);

    await expect(cleanupExpiredTokens()).resolves.toEqual({ refreshTokens: 12, otps: 3 });
  });

  it('supprime les jetons EXPIRÉS ou RÉVOQUÉS, et eux seuls', async () => {
    RefreshToken.destroy.mockResolvedValue(0);
    UserOtp.destroy.mockResolvedValue(0);

    await cleanupExpiredTokens();

    const { where } = RefreshToken.destroy.mock.calls[0][0];
    expect(where[Op.or]).toEqual([
      { expiresAt: { [Op.lt]: expect.any(Date) } },
      { revoked: true },
    ]);
  });

  it('un échec REMONTE — il n’est plus avalé', async () => {
    RefreshToken.destroy.mockRejectedValue(new Error('base indisponible'));

    await expect(cleanupExpiredTokens()).rejects.toThrow('base indisponible');
  });
});

describe('relances d’échéance (J-3)', () => {
  const reserve = (surcharge = {}) => ({
    id: 'r1', numero: 'R-0003', titre: 'Peinture à refaire', assigneA: 'u-assigne', creePar: 'u-createur',
    date_limite: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), ...surcharge,
  });

  it('prévient l’ASSIGNÉ, à défaut le créateur', async () => {
    Reserve.findAll.mockResolvedValue([reserve(), reserve({ id: 'r2', assigneA: null })]);

    await relancerEcheances();

    expect(NotificationService.notifier).toHaveBeenCalledTimes(2);
    expect(NotificationService.notifier.mock.calls[0][0]).toMatchObject({
      utilisateurId: 'u-assigne', type: 'reserve.echeance_proche', donnees: { reserveId: 'r1' },
    });
    expect(NotificationService.notifier.mock.calls[1][0].utilisateurId).toBe('u-createur');
  });

  it('une seule relance par réserve : déjà notifiée, rien ne repart', async () => {
    Reserve.findAll.mockResolvedValue([reserve()]);
    NotificationService.dejaNotifie.mockResolvedValue(true);

    await relancerEcheances();

    expect(NotificationService.notifier).not.toHaveBeenCalled();
  });

  it('ignore les réserves déjà tranchées (validée, clôturée, refusée)', async () => {
    Reserve.findAll.mockResolvedValue([]);

    await relancerEcheances();

    const { where } = Reserve.findAll.mock.calls[0][0];
    expect(where.statut[Op.notIn]).toEqual(['validee', 'cloturee', 'refusee']);
  });

  it('un échec REMONTE — la pile n’est plus perdue', async () => {
    Reserve.findAll.mockRejectedValue(new Error('délai dépassé'));

    await expect(relancerEcheances()).rejects.toThrow('délai dépassé');
  });
});
