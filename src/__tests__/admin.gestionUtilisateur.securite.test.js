'use strict';

/**
 * Tests — gestion des comptes par le super-admin (`/admin/utilisateurs`).
 *
 * ## 1. Le mot de passe « Temp1234! »
 *
 * `creerUtilisateur` retombait sur un mot de passe LITTÉRAL, écrit dans le
 * code, quand aucun n'était fourni. Or l'écran de la plateforme l'envoyait
 * sous la clé `motDePasse` alors que le schéma attend `mot_de_passe` :
 * `stripUnknown` retirait la saisie, et CHAQUE compte créé depuis
 * l'interface recevait `Temp1234!` — y compris un compte `Admin`. Rien côté
 * serveur n'imposait de le changer (`mdp_temporaire` n'est qu'une indication
 * lue par les clients). Connaître l'adresse d'un tel compte suffisait à s'y
 * connecter.
 *
 * ## 2. Les modifications sur soi-même
 *
 * `changerRole` et `supprimerUtilisateur` refusaient d'agir sur son propre
 * compte, mais `modifierUtilisateur` non : un admin pouvait se désactiver
 * (et, s'il était seul, fermer l'administration à tout le monde), se
 * rattacher à une organisation, ou changer son mot de passe sans fournir
 * l'actuel — ce que fait précisément une session volée pour s'installer.
 *
 * ## 3. Les sessions de la cible
 *
 * Redéfinir le mot de passe d'un compte (typiquement : il a été compromis)
 * laissait ses jetons en circulation — jusqu'à une heure pour l'accès, sept
 * jours renouvelables pour le refresh. `account.service` ferme tout lors d'un
 * changement ou d'une réinitialisation ; le chemin d'administration, non.
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: {
    findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), count: jest.fn(),
  },
  Organisation: { findByPk: jest.fn() },
  RefreshToken: { update: jest.fn() },
}));

jest.mock('../config/db.js', () => ({
  transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })),
}));

jest.mock('../modules/admin/service/auditLog.service.js', () => ({ logAction: jest.fn() }));
// Importé par le service pour la suppression RGPD ; hors sujet ici, et son
// propre graphe d'imports tire `otplib` (ESM) que jest ne transforme pas.
jest.mock('../modules/account/service/account.service.js', () => ({ pseudonymiserEtSupprimer: jest.fn() }));
jest.mock('../modules/subscription/service/essai.service.js', () => ({ demarrerEssai: jest.fn() }));
jest.mock('../infrastructure/emailService.js', () => ({ sendNouveauMembreEmail: jest.fn() }));

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Utilisateur, Organisation, RefreshToken } = require('../models/index.js');
const { sendNouveauMembreEmail } = require('../infrastructure/emailService.js');
const validate = require('../middlewares/validate.middleware.js');
const {
  creerUtilisateurAdminSchema, modifierUtilisateurAdminSchema,
} = require('../modules/admin/validation/admin.validation.js');
const Service = require('../modules/admin/service/gestionUtilisateur.service.js');

const ADMIN = { id: 'admin-1', role: 'Admin', prenom: 'Super', nom: 'Admin', email: 'sa@plateforme.io' };
const ORG = '3f2c6b1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f';

/** Fait passer un corps par le VRAI middleware de validation (stripUnknown). */
function valider(schema, body) {
  const req = { body, method: 'POST', originalUrl: '/api/v1/admin/utilisateurs' };
  let erreur = null;
  validate(schema)(req, {}, (e) => { erreur = e || null; });
  if (erreur) throw erreur;
  return req.body;
}

/** Instance Sequelize doublée : `update` applique réellement les champs. */
function compte(champs) {
  const u = { token_version: 0, statut: 'actif', organisationId: null, permissions: null, ...champs };
  u.update = jest.fn(async (maj) => Object.assign(u, maj));
  return u;
}

const CREATION = {
  nom: 'Diop', prenom: 'Awa', email: 'awa@client.sn', role: 'ChefProjet',
  statut: 'actif', organisationId: ORG, fonction: '',
};

beforeEach(() => {
  Utilisateur.findOne.mockResolvedValue(null);
  Utilisateur.count.mockResolvedValue(1);
  Utilisateur.create.mockImplementation(async (d) => ({ id: 'nouveau', ...d }));
  Organisation.findByPk.mockResolvedValue({ id: ORG, nom: 'BTP Dakar' });
  RefreshToken.update.mockResolvedValue([1]);
  sendNouveauMembreEmail.mockResolvedValue({ id: 'courriel' });
});

// ── 1. Création ─────────────────────────────────────────────────────────────

describe('création d’un compte depuis la plateforme', () => {
  it('le mot de passe choisi dans l’écran est bien celui du compte', async () => {
    const body = valider(creerUtilisateurAdminSchema, { ...CREATION, mot_de_passe: 'Choisi#2026x' });

    await Service.creerUtilisateur(body, ADMIN, '127.0.0.1');

    const { mot_de_passe: empreinte } = Utilisateur.create.mock.calls[0][0];
    expect(await bcrypt.compare('Choisi#2026x', empreinte)).toBe(true);
  });

  it('sans mot de passe : jamais la valeur fixe « Temp1234! »', async () => {
    // Exactement ce que produisait l'écran : la clé `motDePasse` est retirée
    // par la validation, le service ne reçoit AUCUN mot de passe.
    const body = valider(creerUtilisateurAdminSchema, { ...CREATION, motDePasse: 'Ignore#2026' });
    expect(body.mot_de_passe).toBeUndefined();

    const r = await Service.creerUtilisateur(body, ADMIN, '127.0.0.1');

    const cree = Utilisateur.create.mock.calls[0][0];
    expect(await bcrypt.compare('Temp1234!', cree.mot_de_passe)).toBe(false);
    // Un mot de passe temporaire aléatoire, transmis une fois, à changer.
    expect(r.motDePasseTemporaire).toEqual(expect.any(String));
    expect(r.motDePasseTemporaire.length).toBeGreaterThanOrEqual(12);
    expect(await bcrypt.compare(r.motDePasseTemporaire, cree.mot_de_passe)).toBe(true);
    expect(cree.mdp_temporaire).toBe(true);
    expect(sendNouveauMembreEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'awa@client.sn', motDePasse: r.motDePasseTemporaire,
    }));
    expect(r.emailEnvoye).toBe(true);
  });

  it('deux comptes créés sans mot de passe n’obtiennent pas le même', async () => {
    const a = await Service.creerUtilisateur(valider(creerUtilisateurAdminSchema, CREATION), ADMIN);
    const b = await Service.creerUtilisateur(
      valider(creerUtilisateurAdminSchema, { ...CREATION, email: 'autre@client.sn' }), ADMIN
    );

    expect(a.motDePasseTemporaire).not.toBe(b.motDePasseTemporaire);
  });

  it('une panne d’envoi ne fait pas échouer la création, et se dit', async () => {
    sendNouveauMembreEmail.mockRejectedValue(new Error('fournisseur indisponible'));

    const r = await Service.creerUtilisateur(valider(creerUtilisateurAdminSchema, CREATION), ADMIN);

    expect(r.success).toBe(true);
    expect(r.emailEnvoye).toBe(false);
  });

  it('un mot de passe choisi suit la politique commune (majuscule, minuscule, chiffre)', () => {
    expect(() => valider(creerUtilisateurAdminSchema, { ...CREATION, mot_de_passe: 'motdepasse' })).toThrow();
    expect(() => valider(modifierUtilisateurAdminSchema, { mot_de_passe: 'motdepasse' })).toThrow();
  });

  it('le service ne contient plus aucun mot de passe littéral', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'admin', 'service', 'gestionUtilisateur.service.js'), 'utf8'
    );
    expect(source).not.toMatch(/Temp1234/);
  });
});

// ── 2. Modifications sur soi-même ───────────────────────────────────────────

describe('un admin ne se modifie pas lui-même par cette route', () => {
  const moi = () => compte({ id: ADMIN.id, role: 'Admin', email: ADMIN.email, nom: 'Admin' });

  it.each([
    ['se désactiver', { statut: 'inactif' }],
    ['se rattacher à une organisation', { organisationId: ORG }],
    ['changer ses permissions', { permissions: ['all'] }],
    ['changer son mot de passe sans l’actuel', { mot_de_passe: 'Nouveau#2026' }],
    ['changer son adresse de connexion', { email: 'pirate@evil.io' }],
  ])('refuse de %s', async (_libelle, data) => {
    const cible = moi();
    Utilisateur.findByPk.mockResolvedValue(cible);

    const r = await Service.modifierUtilisateur(ADMIN.id, data, ADMIN, 'ip');

    expect(r.success).toBe(false);
    expect(cible.update).not.toHaveBeenCalled();
  });

  it('laisse corriger son nom même quand l’écran renvoie le formulaire complet', async () => {
    // PlateformeUtilisateurs.jsx envoie TOUJOURS statut, organisation et
    // email, même inchangés : seuls les champs qui CHANGENT comptent.
    const cible = moi();
    Utilisateur.findByPk.mockResolvedValue(cible);

    const r = await Service.modifierUtilisateur(ADMIN.id, {
      nom: 'Ndiaye', prenom: 'Super', email: ADMIN.email, fonction: '', statut: 'actif', organisationId: null,
    }, ADMIN, 'ip');

    expect(r.success).toBe(true);
    expect(cible.nom).toBe('Ndiaye');
  });
});

// ── 3. Sessions de la cible ─────────────────────────────────────────────────

describe('sessions de la cible', () => {
  it('redéfinir son mot de passe périme ses jetons et ferme ses sessions', async () => {
    const cible = compte({ id: 'u2', role: 'ChefProjet', token_version: 3, email: 'c@client.sn' });
    Utilisateur.findByPk.mockResolvedValue(cible);

    const r = await Service.modifierUtilisateur('u2', { mot_de_passe: 'Nouveau#2026' }, ADMIN, 'ip');

    expect(r.success).toBe(true);
    expect(cible.token_version).toBe(4);
    expect(cible.mdp_temporaire).toBe(true);
    expect(RefreshToken.update).toHaveBeenCalledWith(
      { revoked: true },
      expect.objectContaining({ where: { utilisateurId: 'u2', revoked: false } })
    );
  });

  it('désactiver un compte ferme ses sessions', async () => {
    const cible = compte({ id: 'u3', role: 'Client', email: 'x@client.sn' });
    Utilisateur.findByPk.mockResolvedValue(cible);

    await Service.modifierUtilisateur('u3', { statut: 'inactif' }, ADMIN, 'ip');

    expect(RefreshToken.update).toHaveBeenCalledWith(
      { revoked: true },
      expect.objectContaining({ where: { utilisateurId: 'u3', revoked: false } })
    );
  });

  it('changer un simple libellé ne déconnecte personne', async () => {
    const cible = compte({ id: 'u4', role: 'Client', email: 'y@client.sn', token_version: 2 });
    Utilisateur.findByPk.mockResolvedValue(cible);

    await Service.modifierUtilisateur('u4', { fonction: 'Chef de chantier' }, ADMIN, 'ip');

    expect(cible.token_version).toBe(2);
    expect(RefreshToken.update).not.toHaveBeenCalled();
  });
});

// ── 4. Le dernier admin actif ───────────────────────────────────────────────

describe('la plateforme garde toujours un admin actif', () => {
  const autreAdmin = () => compte({ id: 'admin-2', role: 'Admin', email: 'a2@plateforme.io' });

  it('refuse de désactiver le dernier admin actif', async () => {
    Utilisateur.findByPk.mockResolvedValue(autreAdmin());
    Utilisateur.count.mockResolvedValue(0); // aucun AUTRE admin actif

    const r = await Service.modifierUtilisateur('admin-2', { statut: 'inactif' }, ADMIN, 'ip');

    expect(r.success).toBe(false);
  });

  it('refuse de rétrograder le dernier admin actif', async () => {
    const cible = autreAdmin();
    Utilisateur.findByPk.mockResolvedValue(cible);
    Utilisateur.count.mockResolvedValue(0);

    const r = await Service.changerRole('admin-2', 'Client', ADMIN, 'ip');

    expect(r.success).toBe(false);
    expect(cible.update).not.toHaveBeenCalled();
  });

  it('laisse rétrograder un admin quand un autre reste actif', async () => {
    const cible = autreAdmin();
    Utilisateur.findByPk.mockResolvedValue(cible);
    Utilisateur.count.mockResolvedValue(1);

    const r = await Service.changerRole('admin-2', 'Client', ADMIN, 'ip');

    expect(r.success).toBe(true);
    expect(cible.role).toBe('Client');
  });

  it('refuse toujours de changer son propre rôle', async () => {
    Utilisateur.findByPk.mockResolvedValue(compte({ id: ADMIN.id, role: 'Admin' }));

    const r = await Service.changerRole(ADMIN.id, 'Client', ADMIN, 'ip');

    expect(r.success).toBe(false);
  });
});
