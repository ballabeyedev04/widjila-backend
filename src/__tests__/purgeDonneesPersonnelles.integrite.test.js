'use strict';

/**
 * Tests — purge RGPD : effacement définitif des comptes supprimés.
 *
 * L'ancien DELETE visait tous les comptes du délai d'un coup : le premier
 * auteur d'une réserve (clé NOT NULL, sans cascade) faisait échouer TOUTE la
 * purge des comptes, chaque semaine. Vérifié sur PostgreSQL réel par
 * integration/metier.integration.test.js ; ici, la logique de tri.
 */

const { Op } = require('sequelize');

jest.mock('../models/index.js', () => {
  const m = () => ({ findAll: jest.fn().mockResolvedValue([]), destroy: jest.fn().mockResolvedValue(0) });
  return {
    ConnexionLog: m(), AuditLog: m(), Notification: m(), MfaChallenge: m(), UserOtp: m(), Utilisateur: m(),
    Reserve: m(), Commentaire: m(), Signature: m(), Convocation: m(), RefreshToken: m(), DeviceToken: m(),
  };
});
jest.mock('../utils/executerJob.js', () => ({ envelopperJob: (nom, fn) => fn }));

const sequelize = require('../config/db.js');
const models = require('../models/index.js');
const { effacerComptesSupprimes } = require('../jobs/purgeDonneesPersonnelles.job.js');

const TECHNIQUES = ['RefreshToken', 'UserOtp', 'MfaChallenge', 'DeviceToken'];

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of Object.values(models)) m.findAll.mockResolvedValue([]);
  jest.spyOn(sequelize, 'transaction').mockImplementation(async (fn) => fn({}));
});

describe('effacerComptesSupprimes', () => {
  it('n’efface que les comptes qu’aucune pièce engageante ne désigne', async () => {
    models.Utilisateur.findAll.mockResolvedValue([{ id: 'u-auteur' }, { id: 'u-signataire' }, { id: 'u-libre' }]);
    models.Reserve.findAll.mockResolvedValue([{ creePar: 'u-auteur' }]);
    models.Signature.findAll.mockResolvedValue([{ utilisateurId: 'u-signataire' }]);

    const r = await effacerComptesSupprimes(new Date());

    expect(r).toEqual({ effaces: 1, conserves: 2 });
    const [{ where, force }] = models.Utilisateur.destroy.mock.calls[0];
    expect(force).toBe(true);
    expect(where.id[Op.in]).toEqual(['u-libre']);
  });

  it('efface les rattachements techniques AVANT le compte (sinon clé étrangère)', async () => {
    models.Utilisateur.findAll.mockResolvedValue([{ id: 'u-libre' }]);

    await effacerComptesSupprimes(new Date());

    const ordreCompte = models.Utilisateur.destroy.mock.invocationCallOrder[0];
    for (const nom of TECHNIQUES) {
      expect(models[nom].destroy.mock.calls[0][0].where.utilisateurId[Op.in]).toEqual(['u-libre']);
      expect(models[nom].destroy.mock.invocationCallOrder[0]).toBeLessThan(ordreCompte);
    }
  });

  it('une réserve supprimée logiquement désigne encore son auteur (paranoid: false)', async () => {
    models.Utilisateur.findAll.mockResolvedValue([{ id: 'u-1' }]);

    await effacerComptesSupprimes(new Date());

    for (const nom of ['Reserve', 'Commentaire', 'Signature', 'Convocation']) {
      expect(models[nom].findAll.mock.calls[0][0].paranoid).toBe(false);
    }
    expect(models.Utilisateur.findAll.mock.calls[0][0].paranoid).toBe(false);
  });

  it('tous désignés : aucun effacement, aucune erreur', async () => {
    models.Utilisateur.findAll.mockResolvedValue([{ id: 'u-auteur' }]);
    models.Commentaire.findAll.mockResolvedValue([{ utilisateurId: 'u-auteur' }]);

    expect(await effacerComptesSupprimes(new Date())).toEqual({ effaces: 0, conserves: 1 });
    expect(models.Utilisateur.destroy).not.toHaveBeenCalled();
    for (const nom of TECHNIQUES) expect(models[nom].destroy).not.toHaveBeenCalled();
  });

  it('aucun compte dans le délai : aucune requête d’effacement', async () => {
    expect(await effacerComptesSupprimes(new Date())).toEqual({ effaces: 0, conserves: 0 });
    expect(models.Reserve.findAll).not.toHaveBeenCalled();
    expect(models.Utilisateur.destroy).not.toHaveBeenCalled();
  });
});
