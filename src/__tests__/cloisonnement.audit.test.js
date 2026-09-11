'use strict';

/**
 * Tests — audit de sécurité : cloisonnement des chantiers AU SEIN d'une
 * organisation, appliqué par `organisationCible`.
 *
 * Un chantier issu du circuit de demande n'est visible que de son demandeur,
 * des rôles de GESTION, de ses membres et — pour atteindre une réserve
 * confiée — des comptes affectés à l'une de ses réserves. La règle ne vivait
 * que dans la liste et le détail des chantiers : réserves, documents,
 * inspections, plans et rapports d'un chantier caché restaient ouverts à tout
 * membre de l'organisation qui en connaissait l'identifiant.
 */

const modeles = {};
jest.mock('../models/index.js', () => modeles);

const { organisationCible } = require('../utils/organisationRequete.js');

const ORG = 'org-a';
const conducteur = { id: 'u-conducteur', role: 'ConducteurTravaux', organisationId: ORG };
const req = (user) => ({ user });

beforeEach(() => {
  modeles.Chantier = { findByPk: jest.fn() };
  modeles.Reserve = { findByPk: jest.fn(), count: jest.fn().mockResolvedValue(0) };
  modeles.Plan = { findByPk: jest.fn() };
  modeles.Document = { findByPk: jest.fn() };
  modeles.ChantierMembre = { count: jest.fn().mockResolvedValue(0) };
  modeles.ReserveAffectation = { count: jest.fn().mockResolvedValue(0) };
});

const chantierCache = (extra = {}) => ({ id: 'c1', organisationId: ORG, demandeurId: 'u-autre', ...extra });

describe('organisationCible — cloisonnement intra-organisation', () => {
  it('REFUSE un chantier demandé par un autre, sans affectation ni appartenance', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());

    await expect(organisationCible(req(conducteur), { chantierId: 'c1' }))
      .rejects.toThrow('Chantier introuvable');
  });

  it('refuse aussi par un identifiant ENFANT (réserve → chantier caché)', async () => {
    modeles.Reserve.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());

    await expect(organisationCible(req(conducteur), { reserveId: 'r1' }))
      .rejects.toThrow('Chantier introuvable');
  });

  it('refuse par document → chantier caché', async () => {
    modeles.Document.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());

    await expect(organisationCible(req(conducteur), { documentId: 'd1' }))
      .rejects.toThrow('Chantier introuvable');
  });

  it('refuse la suppression d’un média d’une réserve d’un chantier caché (média → réserve → chantier)', async () => {
    modeles.Media = { findByPk: jest.fn().mockResolvedValue({ reserveId: 'r1' }) };
    modeles.Reserve.findByPk.mockResolvedValue({ chantierId: 'c1' });
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());

    await expect(organisationCible(req(conducteur), { mediaId: 'm1' }))
      .rejects.toThrow('Chantier introuvable');
  });

  it('les contrôleurs partenaires et médias passent par organisationCible', () => {
    const fs = require('fs');
    const path = require('path');
    const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', 'modules', ...p), 'utf8');
    expect(lire('organisation', 'controller', 'partenaire.controller.js')).toContain('organisationCible(req, { chantierId');
    expect(lire('media', 'controller', 'media.controller.js')).toContain('organisationCible(req, { mediaId');
  });

  it('laisse passer un chantier hors circuit (sans demandeur)', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache({ demandeurId: null }));
    await expect(organisationCible(req(conducteur), { chantierId: 'c1' })).resolves.toBe(ORG);
  });

  it('laisse passer le demandeur lui-même', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache({ demandeurId: conducteur.id }));
    await expect(organisationCible(req(conducteur), { chantierId: 'c1' })).resolves.toBe(ORG);
  });

  it('laisse passer un membre du chantier', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());
    modeles.ChantierMembre.count.mockResolvedValue(1);
    await expect(organisationCible(req(conducteur), { chantierId: 'c1' })).resolves.toBe(ORG);
  });

  it('laisse passer un sous-traitant affecté à une réserve du chantier', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache());
    modeles.ReserveAffectation.count.mockResolvedValue(1);
    const st = { id: 'u-st', role: 'SousTraitant', organisationId: ORG };
    await expect(organisationCible(req(st), { chantierId: 'c1' })).resolves.toBe(ORG);
  });

  it.each(['ChefProjet', 'MaitreOuvrage', 'Entreprise'])('ne restreint pas la gestion (%s)', async (role) => {
    const org = await organisationCible(req({ id: 'g', role, organisationId: ORG }), { chantierId: 'c1' });
    expect(org).toBe(ORG);
    expect(modeles.Chantier.findByPk).not.toHaveBeenCalled();
  });

  it('un chantier d’une AUTRE organisation est laissé au filtre du service (pas de fuite ici)', async () => {
    modeles.Chantier.findByPk.mockResolvedValue(chantierCache({ organisationId: 'org-b' }));
    await expect(organisationCible(req(conducteur), { chantierId: 'c1' })).resolves.toBe(ORG);
  });
});
