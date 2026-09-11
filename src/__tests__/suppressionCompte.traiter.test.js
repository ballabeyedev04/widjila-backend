'use strict';

/**
 * Tests — traitement d'une demande de suppression de compte (admin).
 *
 * Une décision est une trace : deux admins sur la même demande, ou un double
 * clic, réécrivaient l'auteur, la date et la note de la première décision.
 */

jest.mock('../models/index.js', () => ({ DemandeSuppression: { findByPk: jest.fn(), update: jest.fn() } }));
jest.mock('../infrastructure/emailService.js', () => ({ sendDemandeSuppressionEmail: jest.fn() }));

const { DemandeSuppression } = require('../models/index.js');
const SuppressionCompteService = require('../modules/suppressionCompte/service/suppressionCompte.service.js');

const ADMIN = { id: 'admin-1' };

beforeEach(() => {
  jest.clearAllMocks();
  DemandeSuppression.findByPk.mockResolvedValue({ id: 'd-1', statut: 'en_attente' });
});

describe('SuppressionCompteService.traiter', () => {
  it('écrit la décision SEULEMENT si la demande est encore en attente', async () => {
    DemandeSuppression.update.mockResolvedValue([1]);

    const r = await SuppressionCompteService.traiter('d-1', { statut: 'traitee', note_admin: '  identité vérifiée ' }, ADMIN);

    expect(r.success).toBe(true);
    const [decision, { where }] = DemandeSuppression.update.mock.calls[0];
    expect(where).toEqual({ id: 'd-1', statut: 'en_attente' });
    expect(decision).toMatchObject({ statut: 'traitee', note_admin: 'identité vérifiée', traite_par: 'admin-1' });
    expect(r.demande.statut).toBe('traitee');
  });

  it('déjà tranchée (par un autre admin, ou double clic) : refus, rien n’est réécrit', async () => {
    DemandeSuppression.update.mockResolvedValue([0]);

    const r = await SuppressionCompteService.traiter('d-1', { statut: 'rejetee' }, ADMIN);

    expect(r).toEqual({ success: false, message: 'Cette demande a déjà été traitée.' });
  });

  it('demande inconnue : introuvable, aucune écriture', async () => {
    DemandeSuppression.findByPk.mockResolvedValue(null);

    const r = await SuppressionCompteService.traiter('d-x', { statut: 'traitee' }, ADMIN);

    expect(r.success).toBe(false);
    expect(DemandeSuppression.update).not.toHaveBeenCalled();
  });
});
