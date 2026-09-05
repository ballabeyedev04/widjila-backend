'use strict';

/**
 * Tests — filtre d'action du journal d'audit.
 *
 * ## Le défaut
 *
 * Les actions journalisées sont des chemins pointés, dérivés de la route
 * appelée : `notifications.device-token.create`, `chantiers.valider.update`.
 *
 * L'écran d'administration, lui, propose des verbes — « create », « update »,
 * « delete ». C'est la bonne question à poser devant un journal : on cherche
 * ce qui a été supprimé aujourd'hui, pas qui a appelé `/chantiers/:id`.
 *
 * Le service comparait les deux par ÉGALITÉ STRICTE. Aucun filtre ne
 * rapprochait donc jamais rien : le menu déroulant fonctionnait en apparence,
 * et répondait « aucun événement » quel que soit le contenu du journal.
 *
 * C'est la pire forme de défaut sur un outil d'audit — il ne dit pas qu'il ne
 * sait pas répondre, il répond « rien ».
 */

jest.mock('../models/index.js', () => ({
  AuditLog: { findAndCountAll: jest.fn(), create: jest.fn() },
}));

const { Op } = require('sequelize');
const { AuditLog } = require('../models/index.js');
const AuditLogService = require('../modules/admin/service/auditLog.service.js');

beforeEach(() => {
  jest.clearAllMocks();
  AuditLog.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
});

/** Le `where` réellement transmis à Sequelize. */
const whereUtilise = () => AuditLog.findAndCountAll.mock.calls[0][0].where;

describe('filtre par action', () => {
  it('un VERBE seul est rapproché du suffixe', async () => {
    await AuditLogService.listLogs({ action: 'delete' });

    expect(whereUtilise().action).toEqual({ [Op.endsWith]: '.delete' });
  });

  it('le point de séparation fait partie du motif', async () => {
    // Sans lui, « create » rapprocherait aussi `organisation.membres.recreate`
    // — un mot qui se termine par les mêmes lettres sans être le même verbe.
    await AuditLogService.listLogs({ action: 'create' });

    expect(whereUtilise().action[Op.endsWith]).toBe('.create');
    expect(whereUtilise().action[Op.endsWith]).not.toBe('create');
  });

  it('une action COMPLÈTE reste comparée telle quelle', async () => {
    // Chercher un événement précis doit rester possible : le rapprochement
    // par suffixe ne remplace pas l'égalité, il s'y ajoute.
    await AuditLogService.listLogs({ action: 'chantiers.valider.update' });

    expect(whereUtilise().action).toBe('chantiers.valider.update');
  });

  it('aucun filtre d’action ne pose aucune condition', async () => {
    await AuditLogService.listLogs({});

    expect(whereUtilise()).not.toHaveProperty('action');
  });
});

describe('autres filtres', () => {
  it('le type de cible reste une égalité', async () => {
    await AuditLogService.listLogs({ cibleType: 'chantier' });

    expect(whereUtilise().cibleType).toBe('chantier');
  });

  it('la date de début borne par le bas', async () => {
    await AuditLogService.listLogs({ depuis: '2026-09-01' });

    expect(whereUtilise().createdAt[Op.gte]).toBeInstanceOf(Date);
  });

  it('les événements sortent du plus récent au plus ancien', async () => {
    // Un journal se lit à l'envers : ce qui vient de se passer d'abord.
    await AuditLogService.listLogs({});

    expect(AuditLog.findAndCountAll.mock.calls[0][0].order).toEqual([['createdAt', 'DESC']]);
  });
});
