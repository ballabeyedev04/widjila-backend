'use strict';

/**
 * Tests — l'essai gratuit démarre à la VALIDATION, pas à l'inscription.
 *
 * ## Le défaut
 *
 * `trial_ends_at` était posé à l'inscription. Mais une inscription publique ne
 * donne pas un compte utilisable : elle dépose une demande, et la connexion
 * est refusée tant que le super-admin n'a pas tranché. L'essai s'écoulait donc
 * pendant que l'entreprise attendait, sans qu'elle puisse se connecter une
 * seule fois.
 *
 * Validée au-delà du délai, elle recevait « votre période d'essai est
 * terminée » à sa toute première visite — un message qu'elle ne pouvait lire
 * que comme une panne, ou comme un procédé déloyal.
 *
 * ## Ce que ces tests verrouillent
 *
 * 1. L'inscription ne pose AUCUNE date.
 * 2. La validation la pose, à `TRIAL_JOURS` jours de la décision.
 * 3. Elle ne la pose qu'UNE FOIS : valider un second compte de la même
 *    organisation ne rallonge pas l'essai. Sans cela, il suffirait de faire
 *    valider un membre de plus pour ne jamais le voir expirer.
 * 4. Le second chemin d'activation — l'écran « Utilisateurs », où le
 *    super-admin peut débloquer une demande sans passer par l'écran
 *    « Demandes » — démarre l'essai lui aussi. Oublié, il ouvrait un compte
 *    dont l'essai restait à NULL, c'est-à-dire réputé TERMINÉ.
 * 5. NULL vaut toujours essai terminé pour les gardes : la correction ne
 *    rouvre pas la faille d'accès gratuit permanent (migration 20260814000002).
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), count: jest.fn() },
  Organisation: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), update: jest.fn() },
  // `update` : une désactivation depuis l'écran « Utilisateurs » ferme
  // désormais les sessions du compte (gestionUtilisateur.service.js).
  RefreshToken: { create: jest.fn(), destroy: jest.fn(), count: jest.fn(), update: jest.fn() },
  MfaChallenge: {},
}));

jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));

jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));
jest.mock('../modules/auth/service/connexionLog.service.js', () => ({
  journaliserConnexion: jest.fn(),
}));
jest.mock('../modules/admin/service/auditLog.service.js', () => ({ logAction: jest.fn() }));
jest.mock('../infrastructure/emailService.js', () => ({
  sendInscriptionValideeEmail: jest.fn().mockResolvedValue(true),
  sendInscriptionRejeteeEmail: jest.fn().mockResolvedValue(true),
}));

const { Utilisateur, Organisation } = require('../models/index.js');
const sequelize = require('../config/db.js');
const { TRIAL_JOURS } = require('../config/essai.js');
const EssaiService = require('../modules/subscription/service/essai.service.js');

const ORG = 'org-1';
const JOUR_MS = 24 * 60 * 60 * 1000;

/** Transaction doublée : on vérifie surtout qu'elle est menée à son terme. */
function transactionDoublee() {
  const t = { commit: jest.fn(), rollback: jest.fn() };
  sequelize.transaction.mockResolvedValue(t);
  return t;
}

beforeEach(() => {
  jest.clearAllMocks();
  Organisation.update.mockResolvedValue([1]);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("l'inscription ne démarre pas l'essai", () => {
  const AuthService = require('../modules/auth/service/auth.service.js');

  async function inscrire() {
    Utilisateur.findOne.mockResolvedValue(null);
    Organisation.findOne.mockResolvedValue(null);
    Organisation.create.mockResolvedValue({ id: ORG });
    Utilisateur.create.mockResolvedValue({ id: 'u-1', email: 'a@b.fr' });

    return AuthService.register({
      nom: 'Beye',
      prenom: 'Balla',
      email: 'A@B.fr',
      mot_de_passe: 'Secret!123',
      organisationNom: 'ACME BTP',
    });
  }

  it("crée l'organisation avec `trial_ends_at` à null", async () => {
    const t = transactionDoublee();

    await inscrire();

    const payload = Organisation.create.mock.calls[0][0];
    // `null` EXPLICITE, et non « champ absent » : le modèle porte un défaut
    // qui protège les organisations créées par d'autres chemins (filiale,
    // agence, création par la plateforme). Omettre la clé laisserait ce défaut
    // s'appliquer, et l'essai repartirait de l'inscription.
    expect(payload).toHaveProperty('trial_ends_at', null);
    expect(t.commit).toHaveBeenCalled();
  });

  it("le compte créé reste en attente — c'est ce qui justifie de ne rien démarrer", async () => {
    transactionDoublee();

    await inscrire();

    expect(Utilisateur.create.mock.calls[0][0].statut).toBe('en_attente_validation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('EssaiService.demarrerEssai', () => {
  it(`pose une fin d'essai à ${TRIAL_JOURS} jours`, async () => {
    const avant = Date.now();
    await EssaiService.demarrerEssai(ORG);
    const apres = Date.now();

    const { trial_ends_at: fin } = Organisation.update.mock.calls[0][0];
    expect(fin.getTime()).toBeGreaterThanOrEqual(avant + TRIAL_JOURS * JOUR_MS);
    expect(fin.getTime()).toBeLessThanOrEqual(apres + TRIAL_JOURS * JOUR_MS);
  });

  it("ne démarre que si l'essai n'a JAMAIS démarré", async () => {
    await EssaiService.demarrerEssai(ORG);

    // La condition est portée par le WHERE, pas par une lecture suivie d'une
    // écriture : deux validations simultanées liraient toutes deux NULL et
    // poseraient toutes deux une date. C'est la base qui arbitre.
    expect(Organisation.update.mock.calls[0][1].where).toEqual({
      id: ORG,
      trial_ends_at: null,
      is_subscribed: false,
    });
  });

  it('signale par `false` un essai déjà démarré', async () => {
    Organisation.update.mockResolvedValue([0]);

    await expect(EssaiService.demarrerEssai(ORG)).resolves.toBe(false);
  });

  it('ne touche à rien pour un compte sans organisation (super-admin plateforme)', async () => {
    await expect(EssaiService.demarrerEssai(null)).resolves.toBe(false);
    expect(Organisation.update).not.toHaveBeenCalled();
  });

  it("écrit dans la transaction qu'on lui confie", async () => {
    const t = { commit: jest.fn(), rollback: jest.fn() };

    await EssaiService.demarrerEssai(ORG, { transaction: t });

    expect(Organisation.update.mock.calls[0][1].transaction).toBe(t);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("validation depuis l'écran « Demandes »", () => {
  const DemandeInscriptionService = require('../modules/admin/service/demandeInscription.service.js');
  const admin = { id: 'admin-1', role: 'Admin' };

  function demandeEnAttente() {
    return {
      id: 'u-1',
      email: 'a@b.fr',
      nom: 'Beye',
      prenom: 'Balla',
      role: 'Entreprise',
      statut: 'en_attente_validation',
      organisationId: ORG,
      organisation: { nom: 'ACME BTP' },
      update: jest.fn().mockResolvedValue(true),
    };
  }

  it("démarre l'essai en même temps qu'elle ouvre le compte", async () => {
    const t = transactionDoublee();
    const demande = demandeEnAttente();
    Utilisateur.findByPk.mockResolvedValue(demande);

    const res = await DemandeInscriptionService.valider('u-1', {}, admin, '1.2.3.4');

    expect(res.success).toBe(true);
    expect(demande.update.mock.calls[0][0].statut).toBe('actif');
    expect(Organisation.update).toHaveBeenCalledTimes(1);
    // Les deux écritures dans la MÊME transaction : un compte ouvert dont
    // l'essai n'a pas démarré se heurterait au mur de l'abonnement dès sa
    // première connexion, sans recours autre qu'une correction en base.
    expect(demande.update.mock.calls[0][1].transaction).toBe(t);
    expect(Organisation.update.mock.calls[0][1].transaction).toBe(t);
    expect(t.commit).toHaveBeenCalled();
  });

  it("annule l'ouverture du compte si le démarrage échoue", async () => {
    const t = transactionDoublee();
    Utilisateur.findByPk.mockResolvedValue(demandeEnAttente());
    Organisation.update.mockRejectedValue(new Error('base indisponible'));

    await expect(
      DemandeInscriptionService.valider('u-1', {}, admin, '1.2.3.4')
    ).rejects.toThrow();
    expect(t.rollback).toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
  });

  it('ne rallonge pas un essai déjà en cours', async () => {
    // Second compte d'une organisation déjà ouverte : l'UPDATE conditionnel ne
    // touche aucune ligne, et la validation réussit quand même.
    transactionDoublee();
    Organisation.update.mockResolvedValue([0]);
    Utilisateur.findByPk.mockResolvedValue(demandeEnAttente());

    const res = await DemandeInscriptionService.valider('u-1', {}, admin, '1.2.3.4');

    expect(res.success).toBe(true);
  });

  it('ne touche à rien pour une demande déjà tranchée', async () => {
    const demande = demandeEnAttente();
    demande.statut = 'actif';
    Utilisateur.findByPk.mockResolvedValue(demande);

    const res = await DemandeInscriptionService.valider('u-1', {}, admin, '1.2.3.4');

    expect(res.success).toBe(false);
    expect(Organisation.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("activation depuis l'écran « Utilisateurs »", () => {
  const GestionUtilisateurService = require('../modules/admin/service/gestionUtilisateur.service.js');
  const admin = { id: 'admin-1', role: 'Admin' };

  function utilisateur(statut) {
    return {
      id: 'u-1',
      email: 'a@b.fr',
      statut,
      organisationId: ORG,
      update: jest.fn().mockResolvedValue(true),
    };
  }

  it("démarre l'essai quand une inscription en attente est débloquée ici", async () => {
    transactionDoublee();
    Utilisateur.findByPk.mockResolvedValue(utilisateur('en_attente_validation'));

    await GestionUtilisateurService.modifierUtilisateur('u-1', { statut: 'actif' }, admin, '1.2.3.4');

    expect(Organisation.update).toHaveBeenCalledTimes(1);
  });

  it('ne redémarre rien pour un compte déjà actif', async () => {
    transactionDoublee();
    Utilisateur.findByPk.mockResolvedValue(utilisateur('actif'));

    await GestionUtilisateurService.modifierUtilisateur('u-1', { nom: 'Diop' }, admin, '1.2.3.4');

    expect(Organisation.update).not.toHaveBeenCalled();
  });

  it("ne démarre rien lors d'une désactivation", async () => {
    transactionDoublee();
    Utilisateur.findByPk.mockResolvedValue(utilisateur('actif'));

    await GestionUtilisateurService.modifierUtilisateur('u-1', { statut: 'inactif' }, admin, '1.2.3.4');

    expect(Organisation.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('les gardes lisent NULL comme un essai terminé', () => {
  const checkSubscription = require('../middlewares/checkSubscription.middleware.js');

  function executer(organisation) {
    Organisation.findByPk.mockResolvedValue(organisation);
    const req = { user: { role: 'Entreprise', organisationId: ORG }, path: '/chantiers' };
    return new Promise((resolve) => checkSubscription(req, {}, resolve));
  }

  it('refuse un `trial_ends_at` NUL', async () => {
    // Règle inchangée, et c'est délibéré : NULL signifie désormais aussi
    // « essai pas encore démarré », mais un compte dans cet état ne peut pas
    // s'authentifier — il n'arrive jamais ici. Fermer reste le bon défaut.
    const err = await executer({ id: ORG, trial_ends_at: null, is_subscribed: false });

    expect(err).toBeDefined();
    expect(err.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('laisse passer un essai en cours', async () => {
    const err = await executer({
      id: ORG,
      trial_ends_at: new Date(Date.now() + JOUR_MS),
      is_subscribed: false,
    });

    expect(err).toBeUndefined();
  });

  it(`annonce la durée réelle de l'essai (${TRIAL_JOURS} jours)`, async () => {
    // Le message citait « 7 jours » en dur. Un chiffre faux dans le seul écran
    // que voit une entreprise bloquée coûte un appel au support.
    const err = await executer({
      id: ORG,
      trial_ends_at: new Date(Date.now() - JOUR_MS),
      is_subscribed: false,
    });

    expect(err.message).toContain(`${TRIAL_JOURS} jours`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cohérence des sources', () => {
  it("aucune durée d'essai recalculée hors de config/essai.js", () => {
    const fs = require('fs');
    const path = require('path');

    const fichiers = [
      'modules/auth/service/auth.service.js',
      'modules/admin/service/demandeInscription.service.js',
      'modules/subscription/service/essai.service.js',
      'middlewares/checkSubscription.middleware.js',
      'models/organisation.model.js',
    ];

    for (const relatif of fichiers) {
      const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
      // « ... 24 * 60 * 60 * 1000 » sur une ligne parlant de trial : c'est
      // exactement la duplication qui avait laissé quatre endroits diverger,
      // et le message d'erreur annoncer 7 jours pour un essai qui n'en durait
      // plus autant.
      const calculEnDur = /trial[^\n]*24 \* 60 \* 60 \* 1000/i.test(source);
      expect({ fichier: relatif, calculEnDur }).toEqual({ fichier: relatif, calculEnDur: false });
    }
  });
});
