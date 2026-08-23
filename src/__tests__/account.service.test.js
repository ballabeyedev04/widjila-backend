'use strict';

/**
 * Tests — modules/account/service/account.service.js#AccountService, focalisés
 * sur les méthodes MFA, sessions et RGPD (module 1) : c'est le PREMIER test de
 * ce service (aucun n'existait avant — seul requireMfaActive.middleware.test.js
 * couvrait ce domaine, et uniquement le middleware). Les modèles Sequelize et
 * MfaService sont mockés pour isoler la logique métier, sans base PostgreSQL
 * réelle — même approche que reserve.changerStatut.roles.test.js.
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: { findByPk: jest.fn(), findOne: jest.fn() },
  ConnexionLog: { findAndCountAll: jest.fn(), update: jest.fn(), findAll: jest.fn() },
  RefreshToken: { findAll: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  MfaChallenge: { destroy: jest.fn() },
  UserOtp: { destroy: jest.fn(), findOne: jest.fn() },
  DeviceToken: { destroy: jest.fn(), findAll: jest.fn() },
  Notification: { findAll: jest.fn() },
  Commentaire: { findAll: jest.fn() },
  Reserve: { findAll: jest.fn() },
  ReserveHistorique: { findAll: jest.fn() },
  Media: { findAll: jest.fn() },
  Signature: { findAll: jest.fn() },
  Annotation: { findAll: jest.fn() },
}));

jest.mock('../modules/auth/service/mfa.service.js', () => ({
  provision: jest.fn(),
  activer: jest.fn(),
  desactiver: jest.fn(),
}));

const {
  Utilisateur, ConnexionLog, RefreshToken, DeviceToken,
  Notification, Commentaire, Reserve, ReserveHistorique, Media, Signature, Annotation,
} = require('../models/index.js');
const MfaService = require('../modules/auth/service/mfa.service.js');
const AccountService = require('../modules/account/service/account.service.js');

// Miroir de EXPORT_MAX_PAR_CATEGORIE (account.service.js) — non exporté par le
// module, dupliqué ici pour construire un jeu de données atteignant le plafond.
const EXPORT_MAX_PAR_CATEGORIE = 500;

function fakeUtilisateur(overrides = {}) {
  return {
    id: 'user-1',
    nom: 'Dupont',
    prenom: 'Jean',
    email: 'jean.dupont@example.com',
    telephone: '0600000000',
    photoProfil: null,
    fonction: 'Chef de projet',
    role: 'ChefProjet',
    statut: 'actif',
    langue: 'fr',
    permissions: [],
    organisationId: 'org-1',
    email_verifie: true,
    mfa_active: false,
    dernierConnexion: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AccountService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listConnexions', () => {
    test('retourne les connexions de l’utilisateur avec le total', async () => {
      const rows = [{ id: 'log-1' }, { id: 'log-2' }];
      ConnexionLog.findAndCountAll.mockResolvedValue({ rows, count: 2 });

      const result = await AccountService.listConnexions('user-1', { page: 1, limit: 20 });

      expect(result).toEqual({ success: true, connexions: rows, total: 2 });
      expect(ConnexionLog.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { utilisateurId: 'user-1' }, limit: 20, offset: 0 })
      );
    });

    test('calcule correctement l’offset pour une page donnée', async () => {
      ConnexionLog.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });

      await AccountService.listConnexions('user-1', { page: 3, limit: 10 });

      expect(ConnexionLog.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 })
      );
    });
  });

  describe('listSessions', () => {
    test('retourne les sessions actives (non révoquées, non expirées) de l’utilisateur', async () => {
      const sessions = [{ id: 'session-1' }, { id: 'session-2' }];
      RefreshToken.findAll.mockResolvedValue(sessions);

      const result = await AccountService.listSessions('user-1');

      expect(result).toEqual({ success: true, sessions });
      expect(RefreshToken.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ utilisateurId: 'user-1', revoked: false }),
        })
      );
    });

    test('retourne une liste vide quand l’utilisateur n’a aucune session active', async () => {
      RefreshToken.findAll.mockResolvedValue([]);

      const result = await AccountService.listSessions('user-1');

      expect(result).toEqual({ success: true, sessions: [] });
    });
  });

  describe('revokeSession', () => {
    test('révoque une session appartenant à l’utilisateur', async () => {
      const session = { id: 'session-1', update: jest.fn().mockResolvedValue(undefined) };
      RefreshToken.findOne.mockResolvedValue(session);

      const result = await AccountService.revokeSession('user-1', 'session-1');

      expect(result).toEqual({ success: true, message: 'Session révoquée' });
      expect(session.update).toHaveBeenCalledWith({ revoked: true });
      expect(RefreshToken.findOne).toHaveBeenCalledWith({
        where: { id: 'session-1', utilisateurId: 'user-1' },
      });
    });

    test('échoue si la session est introuvable', async () => {
      RefreshToken.findOne.mockResolvedValue(null);

      const result = await AccountService.revokeSession('user-1', 'session-inconnue');

      expect(result).toEqual({ success: false, message: 'Session introuvable' });
    });

    test('échoue si la session appartient à un autre utilisateur', async () => {
      // Le where inclut utilisateurId : une session d'un autre utilisateur
      // n'est simplement jamais trouvée par cette requête.
      RefreshToken.findOne.mockResolvedValue(null);

      const result = await AccountService.revokeSession('user-1', 'session-d-un-autre');

      expect(result.success).toBe(false);
      expect(RefreshToken.findOne).toHaveBeenCalledWith({
        where: { id: 'session-d-un-autre', utilisateurId: 'user-1' },
      });
    });
  });

  describe('revokeAllSessions', () => {
    test('révoque toutes les sessions actives de l’utilisateur', async () => {
      RefreshToken.update.mockResolvedValue([2]);

      const result = await AccountService.revokeAllSessions('user-1');

      expect(result).toEqual({ success: true, message: 'Toutes les sessions ont été révoquées' });
      expect(RefreshToken.update).toHaveBeenCalledWith(
        { revoked: true },
        { where: { utilisateurId: 'user-1', revoked: false } }
      );
    });

    test('retourne un succès même si aucune session n’était active', async () => {
      RefreshToken.update.mockResolvedValue([0]);

      const result = await AccountService.revokeAllSessions('user-1');

      expect(result.success).toBe(true);
    });
  });

  describe('provisionMfa', () => {
    test('génère le secret et le QR code quand le MFA n’est pas encore actif', async () => {
      const utilisateur = fakeUtilisateur({ mfa_active: false });
      Utilisateur.findByPk.mockResolvedValue(utilisateur);
      MfaService.provision.mockResolvedValue({
        secret: 'SECRET', otpauthUrl: 'otpauth://totp/...', qr: 'data:image/png;base64,...',
      });

      const result = await AccountService.provisionMfa('user-1');

      expect(result).toEqual({
        success: true, secret: 'SECRET', otpauthUrl: 'otpauth://totp/...', qr: 'data:image/png;base64,...',
      });
      expect(MfaService.provision).toHaveBeenCalledWith(utilisateur);
    });

    test('échoue si l’utilisateur est introuvable', async () => {
      Utilisateur.findByPk.mockResolvedValue(null);

      const result = await AccountService.provisionMfa('user-inconnu');

      expect(result).toEqual({ success: false, message: 'Utilisateur introuvable' });
      expect(MfaService.provision).not.toHaveBeenCalled();
    });

    test('échoue si le MFA est déjà activé sur le compte', async () => {
      Utilisateur.findByPk.mockResolvedValue(fakeUtilisateur({ mfa_active: true }));

      const result = await AccountService.provisionMfa('user-1');

      expect(result).toEqual({ success: false, message: 'Le MFA est déjà activé sur ce compte' });
      expect(MfaService.provision).not.toHaveBeenCalled();
    });
  });

  describe('activerMfa', () => {
    test('active le MFA quand le code fourni est valide', async () => {
      const utilisateur = fakeUtilisateur();
      Utilisateur.findByPk.mockResolvedValue(utilisateur);
      MfaService.activer.mockResolvedValue({ success: true, message: 'Authentification à deux facteurs activée' });

      const result = await AccountService.activerMfa('user-1', { code: '123456', secret: 'SECRET' });

      expect(result).toEqual({ success: true, message: 'Authentification à deux facteurs activée' });
      expect(MfaService.activer).toHaveBeenCalledWith(utilisateur, { code: '123456', secret: 'SECRET' });
    });

    test('échoue si l’utilisateur est introuvable', async () => {
      Utilisateur.findByPk.mockResolvedValue(null);

      const result = await AccountService.activerMfa('user-inconnu', { code: '123456', secret: 'SECRET' });

      expect(result).toEqual({ success: false, message: 'Utilisateur introuvable' });
      expect(MfaService.activer).not.toHaveBeenCalled();
    });

    test('répercute l’échec quand le code de vérification est invalide', async () => {
      Utilisateur.findByPk.mockResolvedValue(fakeUtilisateur());
      MfaService.activer.mockResolvedValue({ success: false, message: 'Code de vérification invalide' });

      const result = await AccountService.activerMfa('user-1', { code: '000000', secret: 'SECRET' });

      expect(result).toEqual({ success: false, message: 'Code de vérification invalide' });
    });
  });

  describe('desactiverMfa', () => {
    test('désactive le MFA quand le code fourni est valide', async () => {
      const utilisateur = fakeUtilisateur({ mfa_active: true });
      Utilisateur.findByPk.mockResolvedValue(utilisateur);
      MfaService.desactiver.mockResolvedValue({ success: true, message: 'Authentification à deux facteurs désactivée' });

      const result = await AccountService.desactiverMfa('user-1', { code: '123456' });

      expect(result).toEqual({ success: true, message: 'Authentification à deux facteurs désactivée' });
      expect(MfaService.desactiver).toHaveBeenCalledWith(utilisateur, { code: '123456' });
    });

    test('échoue si l’utilisateur est introuvable', async () => {
      Utilisateur.findByPk.mockResolvedValue(null);

      const result = await AccountService.desactiverMfa('user-inconnu', { code: '123456' });

      expect(result).toEqual({ success: false, message: 'Utilisateur introuvable' });
      expect(MfaService.desactiver).not.toHaveBeenCalled();
    });

    test('répercute l’échec quand le code de vérification est invalide', async () => {
      Utilisateur.findByPk.mockResolvedValue(fakeUtilisateur({ mfa_active: true }));
      MfaService.desactiver.mockResolvedValue({ success: false, message: 'Code de vérification invalide' });

      const result = await AccountService.desactiverMfa('user-1', { code: '000000' });

      expect(result).toEqual({ success: false, message: 'Code de vérification invalide' });
    });
  });

  describe('deleteAccount', () => {
    test('pseudonymise et supprime le compte d’un utilisateur non-Admin', async () => {
      const utilisateur = fakeUtilisateur({ role: 'ChefProjet' });
      Utilisateur.findByPk.mockResolvedValue(utilisateur);
      const pseudonymiserSpy = jest
        .spyOn(AccountService, 'pseudonymiserEtSupprimer')
        .mockResolvedValue({ connexionLogsAnonymises: 3 });

      const result = await AccountService.deleteAccount('user-1');

      expect(result).toEqual({
        success: true,
        message: "Votre compte a été supprimé conformément à votre droit à l'effacement.",
      });
      expect(pseudonymiserSpy).toHaveBeenCalledWith(utilisateur);

      pseudonymiserSpy.mockRestore();
    });

    test('échoue si l’utilisateur est introuvable', async () => {
      Utilisateur.findByPk.mockResolvedValue(null);
      const pseudonymiserSpy = jest.spyOn(AccountService, 'pseudonymiserEtSupprimer');

      const result = await AccountService.deleteAccount('user-inconnu');

      expect(result).toEqual({ error: 'Utilisateur introuvable' });
      expect(pseudonymiserSpy).not.toHaveBeenCalled();

      pseudonymiserSpy.mockRestore();
    });

    test('refuse la suppression d’un compte Admin via cette route', async () => {
      Utilisateur.findByPk.mockResolvedValue(fakeUtilisateur({ role: 'Admin' }));
      const pseudonymiserSpy = jest.spyOn(AccountService, 'pseudonymiserEtSupprimer');

      const result = await AccountService.deleteAccount('user-admin');

      expect(result).toEqual({ error: 'Un compte Admin ne peut pas être supprimé via cette route.' });
      expect(pseudonymiserSpy).not.toHaveBeenCalled();

      pseudonymiserSpy.mockRestore();
    });
  });

  describe('exportData', () => {
    function mockCollectionsVides() {
      ConnexionLog.findAll.mockResolvedValue([]);
      RefreshToken.findAll.mockResolvedValue([]);
      DeviceToken.findAll.mockResolvedValue([]);
      Notification.findAll.mockResolvedValue([]);
      Commentaire.findAll.mockResolvedValue([]);
      Reserve.findAll.mockResolvedValue([]);
      ReserveHistorique.findAll.mockResolvedValue([]);
      Media.findAll.mockResolvedValue([]);
      Signature.findAll.mockResolvedValue([]);
      Annotation.findAll.mockResolvedValue([]);
    }

    test('construit l’export complet (profil, sécurité, activité, contenus, communications)', async () => {
      const utilisateur = fakeUtilisateur();
      Utilisateur.findByPk.mockResolvedValue(utilisateur);
      mockCollectionsVides();
      ConnexionLog.findAll.mockResolvedValue([{ id: 'log-1' }]);
      RefreshToken.findAll.mockResolvedValue([{ id: 'session-1' }]);

      const result = await AccountService.exportData('user-1');

      expect(result.success).toBe(true);
      expect(result.profil).toEqual(
        expect.objectContaining({ id: 'user-1', email: utilisateur.email, role: utilisateur.role })
      );
      expect(result.securite.connexions).toEqual({ nombre: 1, tronque: false, elements: [{ id: 'log-1' }] });
      expect(result.securite.sessions).toEqual({ nombre: 1, tronque: false, elements: [{ id: 'session-1' }] });
      expect(result.securite.appareils).toEqual({ nombre: 0, tronque: false, elements: [] });
      expect(result.activite).toEqual(
        expect.objectContaining({
          reservesCreees: { nombre: 0, tronque: false, elements: [] },
          reservesAssignees: { nombre: 0, tronque: false, elements: [] },
        })
      );
      expect(result.contenus).toEqual({ medias: { nombre: 0, tronque: false, elements: [] } });
      expect(result.communications).toEqual({ notifications: { nombre: 0, tronque: false, elements: [] } });
    });

    test('échoue si l’utilisateur est introuvable', async () => {
      Utilisateur.findByPk.mockResolvedValue(null);

      const result = await AccountService.exportData('user-inconnu');

      expect(result).toEqual({ error: 'Utilisateur introuvable' });
    });

    test('signale la troncature (« tronque » à true) quand une catégorie atteint le plafond', async () => {
      Utilisateur.findByPk.mockResolvedValue(fakeUtilisateur());
      mockCollectionsVides();
      const mediasAuPlafond = Array.from({ length: EXPORT_MAX_PAR_CATEGORIE }, (_, i) => ({ id: `media-${i}` }));
      Media.findAll.mockResolvedValue(mediasAuPlafond);

      const result = await AccountService.exportData('user-1');

      expect(result.contenus.medias.nombre).toBe(EXPORT_MAX_PAR_CATEGORIE);
      expect(result.contenus.medias.tronque).toBe(true);
    });
  });
});

describe('changePassword — révocation des autres sessions', () => {
  const bcrypt = require('bcryptjs');
  const hashToken = require('../utils/hashToken.js');
  const { Op } = require('sequelize');

  function utilisateurAvecMotDePasse() {
    return {
      id: 'user-1',
      mot_de_passe: 'hash-actuel',
      mdp_temporaire: true,
      save: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    RefreshToken.update.mockReset();
    RefreshToken.update.mockResolvedValue([2]);
  });

  test('épargne la session courante quand le refresh token est fourni', async () => {
    const utilisateur = utilisateurAvecMotDePasse();
    Utilisateur.findByPk.mockResolvedValue(utilisateur);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    const resultat = await AccountService.changePassword(
      'user-1', 'Ancien123', 'Nouveau123', 'refresh-de-cet-appareil'
    );

    expect(resultat.error).toBeUndefined();
    expect(resultat.sessionsRevoquees).toBe(2);

    // Le filtre doit EXCLURE l'empreinte de la session courante : sans ce
    // `Op.ne`, l'utilisateur serait déconnecté au moment même où il sécurise
    // son compte.
    const [valeurs, options] = RefreshToken.update.mock.calls[0];
    expect(valeurs).toEqual({ revoked: true });
    expect(options.where.utilisateurId).toBe('user-1');
    expect(options.where.revoked).toBe(false);
    expect(options.where.tokenHash).toEqual({ [Op.ne]: hashToken('refresh-de-cet-appareil') });
  });

  test('révoque TOUT quand aucun refresh token n\'est fourni', async () => {
    Utilisateur.findByPk.mockResolvedValue(utilisateurAvecMotDePasse());
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    await AccountService.changePassword('user-1', 'Ancien123', 'Nouveau123');

    // Pas de `tokenHash` dans le filtre : on préfère une reconnexion de trop
    // à une session volée laissée ouverte.
    const [, options] = RefreshToken.update.mock.calls[0];
    expect(options.where.tokenHash).toBeUndefined();
  });

  test('solde le mot de passe provisoire', async () => {
    const utilisateur = utilisateurAvecMotDePasse();
    Utilisateur.findByPk.mockResolvedValue(utilisateur);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    await AccountService.changePassword('user-1', 'Ancien123', 'Nouveau123', 'refresh');

    expect(utilisateur.mdp_temporaire).toBe(false);
    expect(utilisateur.save).toHaveBeenCalled();
  });

  test('mot de passe actuel incorrect : aucune session touchée', async () => {
    Utilisateur.findByPk.mockResolvedValue(utilisateurAvecMotDePasse());
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

    const resultat = await AccountService.changePassword('user-1', 'faux', 'Nouveau123', 'refresh');

    expect(resultat.error).toBe('Mot de passe actuel incorrect.');
    // Un échec d'authentification ne doit surtout pas déconnecter les
    // appareils légitimes — ce serait un déni de service à portée de main de
    // quiconque connaît l'email de la victime.
    expect(RefreshToken.update).not.toHaveBeenCalled();
  });
});

describe('token_version — invalidation des tokens d\'accès', () => {
  const bcrypt = require('bcryptjs');
  // `UserOtp` est mocké en tête de fichier mais pas déstructuré dans le
  // require partagé — on le récupère ici, où il sert.
  const { UserOtp } = require('../models/index.js');

  beforeEach(() => {
    jest.restoreAllMocks();
    RefreshToken.update.mockReset();
    RefreshToken.update.mockResolvedValue([0]);
  });

  test('changePassword incrémente token_version et rend un token neuf', async () => {
    const utilisateur = {
      id: 'user-1',
      mot_de_passe: 'hash',
      mdp_temporaire: false,
      token_version: 3,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Utilisateur.findByPk.mockResolvedValue(utilisateur);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    const resultat = await AccountService.changePassword(
      'user-1', 'Ancien123', 'Nouveau123', 'refresh-courant'
    );

    expect(utilisateur.token_version).toBe(4);
    // Sans ce token neuf, l'appareil qui vient de sécuriser son compte se
    // ferait déconnecter par sa propre action à la requête suivante.
    expect(typeof resultat.accessToken).toBe('string');
    expect(resultat.accessToken.length).toBeGreaterThan(0);
  });

  test('le token rendu porte la NOUVELLE version', async () => {
    const jwt = require('jsonwebtoken');
    const utilisateur = {
      id: 'user-1',
      role: 'ChefProjet',
      organisationId: 'org-1',
      mot_de_passe: 'hash',
      mdp_temporaire: false,
      token_version: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Utilisateur.findByPk.mockResolvedValue(utilisateur);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    const resultat = await AccountService.changePassword(
      'user-1', 'Ancien123', 'Nouveau123', 'refresh-courant'
    );

    // Décodé sans vérifier la signature : le test porte sur le CONTENU, pas
    // sur la configuration du secret.
    const charge = jwt.decode(resultat.accessToken);
    expect(charge.tv).toBe(1);
    expect(charge.id).toBe('user-1');
  });

  test('resetPassword incrémente token_version ET révoque tout', async () => {
    const utilisateur = {
      id: 'user-1',
      email: 'jean@example.com',
      mot_de_passe: 'hash',
      mdp_temporaire: true,
      token_version: 7,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Utilisateur.findOne.mockResolvedValue(utilisateur);
    UserOtp.findOne.mockResolvedValue({
      otpHash: 'hash-otp',
      expiresAt: new Date(Date.now() + 60000),
      destroy: jest.fn().mockResolvedValue(undefined),
    });
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hash-nouveau');

    const resultat = await AccountService.resetPassword('jean@example.com', 'ABC123', 'Nouveau123');

    expect(resultat.error).toBeUndefined();
    expect(utilisateur.token_version).toBe(8);
    // Réinitialisation = compromission présumée : AUCUNE session épargnée,
    // donc pas de filtre `tokenHash` dans la clause.
    const [, options] = RefreshToken.update.mock.calls[0];
    expect(options.where.utilisateurId).toBe('user-1');
    expect(options.where.tokenHash).toBeUndefined();
  });
});
