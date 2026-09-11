'use strict';

/**
 * Tests — gestion des membres par l'organisation (l'« admin » d'un client).
 *
 * ## Ce qui était ouvert
 *
 * 1. IMPORT CSV (critique) : le rôle par défaut venait d'un champ multipart
 *    qu'aucun schéma ne valide. `role=Admin` créait des super-administrateurs
 *    de la PLATEFORME — autant que de lignes dans le fichier.
 * 2. RANG : la garde d'élévation ne refusait plus jamais rien (tout appelant
 *    de ces routes est dans GESTION). Un chef de projet rétrogradait,
 *    désactivait ou supprimait le titulaire qui l'avait invité, ou se créait
 *    un compte `Entreprise`.
 * 3. SUPER-ADMIN : seul le rôle VISÉ était contrôlé, pas celui de la CIBLE —
 *    un compte `Admin` rattaché à l'organisation se rétrogradait en `Client`.
 * 4. DERNIER GESTIONNAIRE : rien n'empêchait de retirer le dernier, laissant
 *    une organisation que plus personne n'administre.
 * 5. PLAFOND : réactiver un compte, ou importer 500 lignes, contournait le
 *    nombre d'utilisateurs de la formule.
 * 6. MASS ASSIGNMENT : `abonnement` (libellé de formule lu par les
 *    statistiques du super-admin) se modifiait depuis l'organisation.
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: { findOne: jest.fn(), findAll: jest.fn(), count: jest.fn(), create: jest.fn() },
  Organisation: { findByPk: jest.fn(), findOne: jest.fn() },
  Equipe: {},
  RefreshToken: { update: jest.fn() },
}));
jest.mock('../infrastructure/storage.service.js', () => ({ storeFile: jest.fn() }));
jest.mock('../infrastructure/emailService.js', () => ({ sendNouveauMembreEmail: jest.fn() }));
jest.mock('../modules/account/service/account.service.js', () => ({ pseudonymiserEtSupprimer: jest.fn() }));
jest.mock('../modules/subscription/service/droits.service.js', () => ({ verifierLimite: jest.fn() }));

const { Utilisateur, Organisation, RefreshToken } = require('../models/index.js');
const AccountService = require('../modules/account/service/account.service.js');
const DroitsService = require('../modules/subscription/service/droits.service.js');
const validate = require('../middlewares/validate.middleware.js');
const { modifierMembreSchema } = require('../modules/organisation/validation/organisation.validation.js');
const Service = require('../modules/organisation/service/organisation.service.js');

const ORG = 'org-1';
const TITULAIRE = { id: 'u-titulaire', role: 'Entreprise', prenom: 'Awa', nom: 'Sow' };
const CHEF = { id: 'u-chef', role: 'ChefProjet', prenom: 'Moussa', nom: 'Fall' };

/** Membre en base, doublé : `update` applique réellement les champs. */
function membre(champs) {
  const m = { organisationId: ORG, statut: 'actif', ...champs };
  m.update = jest.fn(async (maj) => Object.assign(m, maj));
  return m;
}

beforeEach(() => {
  Utilisateur.count.mockResolvedValue(1); // un autre gestionnaire actif existe
  Utilisateur.findOne.mockResolvedValue(null);
  Utilisateur.create.mockImplementation(async (d) => ({ id: 'cree', ...d }));
  RefreshToken.update.mockResolvedValue([1]);
  DroitsService.verifierLimite.mockResolvedValue({ autorise: true, limite: null });
});

// ── 1. Import CSV ───────────────────────────────────────────────────────────

describe('import de contacts', () => {
  const csv = (lignes) => Buffer.from(['prenom,nom,email,role', ...lignes].join('\n'));

  it('refuse le rôle par défaut « Admin » — aucun super-admin créé', async () => {
    const r = await Service.importContacts(ORG, csv(['A,B,a@x.io,']), 'Admin', TITULAIRE);

    expect(r.success).toBe(false);
    expect(Utilisateur.create).not.toHaveBeenCalled();
  });

  it('refuse un rôle par défaut inconnu', async () => {
    const r = await Service.importContacts(ORG, csv(['A,B,a@x.io,']), 'Root', TITULAIRE);

    expect(r.success).toBe(false);
    expect(Utilisateur.create).not.toHaveBeenCalled();
  });

  it('une ligne « Admin » retombe sur le rôle par défaut, jamais sur Admin', async () => {
    const r = await Service.importContacts(ORG, csv(['A,B,a@x.io,Admin']), 'Client', TITULAIRE);

    expect(r.success).toBe(true);
    expect(Utilisateur.create.mock.calls[0][0].role).toBe('Client');
  });

  it('un chef de projet n’importe pas de compte de rang supérieur au sien', async () => {
    const r = await Service.importContacts(ORG, csv(['A,B,a@x.io,Entreprise']), 'Client', CHEF);

    expect(Utilisateur.create).not.toHaveBeenCalled();
    expect(r.results[0]).toEqual(expect.objectContaining({ statut: 'erreur' }));
  });

  it('s’arrête au plafond de la formule', async () => {
    DroitsService.verifierLimite.mockResolvedValue({ autorise: true, limite: 3, courant: 2 });

    const r = await Service.importContacts(ORG, csv(['A,B,a@x.io,Client', 'C,D,c@x.io,Client']), 'Client', TITULAIRE);

    expect(Utilisateur.create).toHaveBeenCalledTimes(1);
    expect(r.results[1]).toEqual(expect.objectContaining({ statut: 'erreur' }));
  });
});

// ── 2 & 3. Rang et super-admin ──────────────────────────────────────────────

describe('modifier un membre', () => {
  it('ne touche jamais un super-admin rattaché à l’organisation', async () => {
    const admin = membre({ id: 'u-admin', role: 'Admin' });
    Utilisateur.findOne.mockResolvedValue(admin);

    const r = await Service.modifierMembre(ORG, 'u-admin', { role: 'Client' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(false);
    expect(admin.update).not.toHaveBeenCalled();
  });

  it('un chef de projet ne désactive pas le titulaire', async () => {
    const titulaire = membre({ id: TITULAIRE.id, role: 'Entreprise' });
    Utilisateur.findOne.mockResolvedValue(titulaire);

    const r = await Service.modifierMembre(ORG, TITULAIRE.id, { statut: 'inactif' }, CHEF.id, CHEF.role);

    expect(r.success).toBe(false);
    expect(titulaire.update).not.toHaveBeenCalled();
  });

  it('un chef de projet ne promeut pas un membre au rang de titulaire', async () => {
    const m = membre({ id: 'u-m', role: 'ConducteurTravaux' });
    Utilisateur.findOne.mockResolvedValue(m);

    const r = await Service.modifierMembre(ORG, 'u-m', { role: 'Entreprise' }, CHEF.id, CHEF.role);

    expect(r.success).toBe(false);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('le titulaire nomme un chef de projet — non-régression', async () => {
    const m = membre({ id: 'u-m', role: 'ConducteurTravaux' });
    Utilisateur.findOne.mockResolvedValue(m);

    const r = await Service.modifierMembre(ORG, 'u-m', { role: 'ChefProjet' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(true);
    expect(m.role).toBe('ChefProjet');
  });

  it('refuse de replacer un membre « en attente de validation » (file du super-admin)', () => {
    const req = { body: { statut: 'en_attente_validation' }, method: 'PUT', originalUrl: '/organisation/membres/x' };
    let erreur = null;
    validate(modifierMembreSchema)(req, {}, (e) => { erreur = e || null; });

    expect(erreur).not.toBeNull();
  });
});

// ── 4. Dernier gestionnaire ─────────────────────────────────────────────────

describe('le dernier gestionnaire actif', () => {
  it('ne se désactive pas', async () => {
    Utilisateur.count.mockResolvedValue(0);
    const autre = membre({ id: 'u-t2', role: 'Entreprise' });
    Utilisateur.findOne.mockResolvedValue(autre);

    const r = await Service.modifierMembre(ORG, 'u-t2', { statut: 'inactif' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(false);
  });

  it('ne se rétrograde pas', async () => {
    Utilisateur.count.mockResolvedValue(0);
    const chef = membre({ id: 'u-c2', role: 'ChefProjet' });
    Utilisateur.findOne.mockResolvedValue(chef);

    const r = await Service.modifierMembre(ORG, 'u-c2', { role: 'Client' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(false);
  });

  it('ne se supprime pas', async () => {
    Utilisateur.count.mockResolvedValue(0);
    Utilisateur.findOne.mockResolvedValue(membre({ id: 'u-c3', role: 'ChefProjet' }));

    const r = await Service.supprimerMembre(ORG, 'u-c3', TITULAIRE);

    expect(r.success).toBe(false);
    expect(AccountService.pseudonymiserEtSupprimer).not.toHaveBeenCalled();
  });

  it('se désactive quand un autre reste, et perd ses sessions', async () => {
    const chef = membre({ id: 'u-c4', role: 'ChefProjet' });
    Utilisateur.findOne.mockResolvedValue(chef);

    const r = await Service.modifierMembre(ORG, 'u-c4', { statut: 'inactif' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(true);
    expect(RefreshToken.update).toHaveBeenCalledWith(
      { revoked: true }, { where: { utilisateurId: 'u-c4', revoked: false } }
    );
  });
});

// ── Suppression ─────────────────────────────────────────────────────────────

describe('supprimer un membre', () => {
  it('pas soi-même par cette route', async () => {
    const r = await Service.supprimerMembre(ORG, CHEF.id, CHEF);

    expect(r.success).toBe(false);
    expect(Utilisateur.findOne).not.toHaveBeenCalled();
  });

  it('un chef de projet ne supprime pas le titulaire', async () => {
    Utilisateur.findOne.mockResolvedValue(membre({ id: TITULAIRE.id, role: 'Entreprise' }));

    const r = await Service.supprimerMembre(ORG, TITULAIRE.id, CHEF);

    expect(r.success).toBe(false);
    expect(AccountService.pseudonymiserEtSupprimer).not.toHaveBeenCalled();
  });

  it('un chef de projet retire un conducteur de travaux — non-régression', async () => {
    Utilisateur.findOne.mockResolvedValue(membre({ id: 'u-ct', role: 'ConducteurTravaux' }));

    const r = await Service.supprimerMembre(ORG, 'u-ct', CHEF);

    expect(r.success).toBe(true);
    expect(AccountService.pseudonymiserEtSupprimer).toHaveBeenCalled();
  });
});

// ── 5. Plafond à la réactivation ────────────────────────────────────────────

describe('réactiver un membre', () => {
  it('est refusé quand le plafond d’utilisateurs actifs est atteint', async () => {
    DroitsService.verifierLimite.mockResolvedValue({ autorise: false, raison: 'SUBSCRIPTION_LIMIT_REACHED' });
    const m = membre({ id: 'u-i', role: 'Client', statut: 'inactif' });
    Utilisateur.findOne.mockResolvedValue(m);

    const r = await Service.modifierMembre(ORG, 'u-i', { statut: 'actif' }, TITULAIRE.id, TITULAIRE.role);

    expect(r.success).toBe(false);
    expect(m.update).not.toHaveBeenCalled();
  });
});

// ── 6. Mass assignment sur l'organisation ───────────────────────────────────

describe('modifier son organisation', () => {
  it('ignore le libellé de formule `abonnement`', async () => {
    const org = { id: ORG, siret: null, update: jest.fn() };
    Organisation.findByPk.mockResolvedValue(org);

    await Service.modifierOrganisation(ORG, { nom: 'BTP Dakar', abonnement: 'Enterprise' });

    expect(org.update).toHaveBeenCalledWith({ nom: 'BTP Dakar' });
  });
});
