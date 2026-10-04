'use strict';

/**
 * Tests — rappels avant échéance et clôture des abonnements échus
 * (cahier des charges « Premium sur devis » § 9).
 *
 * ## Ce qui est verrouillé
 *
 *   1. trois paliers — J-30, J-7, J-1 — et le bon palier selon l'échéance ;
 *   2. un seul rappel par palier, quel que soit le nombre d'exécutions :
 *      l'anti-doublon s'appuie sur les notifications déjà émises ;
 *   3. seuls les comptes qui peuvent RENOUVELER sont prévenus (groupe
 *      FACTURATION) ;
 *   4. le message annonce la politique d'expiration : pas de coupure, mais
 *      la bascule sur l'offre gratuite — une échéance qui fait peur pousse à
 *      exporter, pas à renouveler ;
 *   5. un abonnement échu est CLÔTURÉ (`expiree`) et l'organisation
 *      désabonnée : une ligne « active » qui ne couvre plus rien trompe
 *      l'administration ;
 *   6. la clôture passe AVANT les rappels — un abonnement expiré ce matin ne
 *      doit pas recevoir « expire dans 1 jour » ;
 *   7. les devis périmés sont refermés pour l'administration.
 */

jest.mock('../models/index.js', () => ({
  AbonnementSouscrit: { findAll: jest.fn(), update: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  Utilisateur: { findAll: jest.fn() },
  Devis: { update: jest.fn() },
}));

jest.mock('../modules/notification/service/notification.service.js', () => ({
  notifier: jest.fn().mockResolvedValue(),
  dejaNotifie: jest.fn().mockResolvedValue(false),
}));

jest.mock('../modules/subscription/service/subscription.service.js', () => ({
  _synchroniserOrganisation: jest.fn().mockResolvedValue(),
}));

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

jest.mock('../infrastructure/emailService.js', () => ({
  sendEcheanceAbonnementEmail: jest.fn().mockResolvedValue(),
}));

const { AbonnementSouscrit, Utilisateur, Devis } = require('../models/index.js');
const NotificationService = require('../modules/notification/service/notification.service.js');
const { sendEcheanceAbonnementEmail } = require('../infrastructure/emailService.js');
const SubscriptionService = require('../modules/subscription/service/subscription.service.js');
const {
  rappelerEcheances, cloturerEchus, fermerDevisPerimes, palierPour, joursRestants,
  PALIERS_JOURS,
} = require('../jobs/rappelsAbonnement.job.js');
const { FACTURATION } = require('../config/roles.js');
const { LIMITE_CHANTIERS, LIMITE_UTILISATEURS } = require('../config/offreGratuite.js');

const ORG = 'org-1';
const JOUR = 24 * 60 * 60 * 1000;

/** Souscription active dont l'échéance tombe dans [jours] jours. */
const souscription = (jours, extra = {}) => {
  const s = {
    id: 'sous-1', organisationId: ORG, plan_code: 'pro', plan_nom: 'Pro',
    statut: 'active',
    // +1 h : `Math.ceil` doit voir le jour entier, pas une frontière exacte.
    date_fin: new Date(Date.now() + jours * JOUR + 3600000),
    organisation: { id: ORG, nom: 'Widjila BTP' },
    ...extra,
  };
  s.update = jest.fn(async (v) => Object.assign(s, v));
  return s;
};

const titulaire = { id: 'u1', email: 'patron@example.com', prenom: 'Balla', nom: 'Beye' };

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.dejaNotifie.mockResolvedValue(false);
  sendEcheanceAbonnementEmail.mockResolvedValue();
  Utilisateur.findAll.mockResolvedValue([titulaire]);
  AbonnementSouscrit.findAll.mockResolvedValue([]);
  Devis.update.mockResolvedValue([0]);
});

describe('les paliers', () => {
  it('sont J-30, J-7 et J-1 — un contrat de BTP se renouvelle avec un bon de commande', () => {
    expect(PALIERS_JOURS).toEqual([30, 7, 1]);
  });

  it.each([
    [40, null],  // trop tôt : rien à dire
    [30, 30],
    [12, 30],
    [7, 7],
    [3, 7],
    [1, 1],
  ])('à %s jours, le palier retenu est %s', (jours, attendu) => {
    expect(palierPour(jours)).toBe(attendu);
  });

  it('compte les jours restants au jour SUPÉRIEUR', () => {
    expect(joursRestants(new Date(Date.now() + 2 * JOUR + 3600000))).toBe(3);
  });
});

describe('les rappels', () => {
  it('prévient le titulaire, en annonçant la bascule sur l’offre gratuite', async () => {
    // Six jours pleins + quelques heures : il reste SEPT jours au compte à
    // rebours, donc le palier J-7 — à huit jours, il ne serait pas atteint.
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await rappelerEcheances();

    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);
    const envoi = NotificationService.notifier.mock.calls[0][0];
    expect(envoi).toMatchObject({
      utilisateurId: 'u1',
      type: 'abonnement.echeance',
      donnees: { souscriptionId: 'sous-1', palier: 7 },
    });
    expect(envoi.titre).toBe('Votre abonnement expire dans 7 jours');
    // La politique d'expiration, dite dès le premier rappel.
    expect(envoi.message).toMatch(/offre gratuite/i);
    expect(envoi.message).toContain(`${LIMITE_CHANTIERS} chantier`);
    expect(envoi.message).toContain(`${LIMITE_UTILISATEURS} utilisateurs`);
    // Ni coupure, ni lecture seule : on ne fait pas peur.
    expect(envoi.message).not.toMatch(/suspendu|coupure|perdu|supprim/i);
  });

  it('ne prévient QUE les comptes qui peuvent renouveler', async () => {
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(7)]);

    await rappelerEcheances();

    const where = Utilisateur.findAll.mock.calls[0][0].where;
    expect(where.organisationId).toBe(ORG);
    expect(where.statut).toBe('actif');
    expect(where.role[Object.getOwnPropertySymbols(where.role)[0]]).toEqual(FACTURATION);
  });

  it('n’envoie qu’UNE fois par palier, même exécuté deux fois', async () => {
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(7)]);
    await rappelerEcheances();
    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);

    // Deuxième passage : la notification existe déjà.
    NotificationService.dejaNotifie.mockResolvedValue(true);
    await rappelerEcheances();

    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);
  });

  it('le passage d’un palier au suivant redéclenche un rappel', async () => {
    // J-30 déjà envoyé ; à J-5 le palier devient 7, donc une autre donnée,
    // donc un autre rappel.
    NotificationService.dejaNotifie.mockImplementation(
      async (_u, _t, donnees) => donnees.palier === 30
    );
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(5)]);

    await rappelerEcheances();

    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifier.mock.calls[0][0].donnees.palier).toBe(7);
  });

  it('prévient CHAQUE compte de facturation', async () => {
    Utilisateur.findAll.mockResolvedValue([titulaire, { id: 'u2', email: 'dg@example.com' }]);
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(1)]);

    await rappelerEcheances();

    expect(NotificationService.notifier).toHaveBeenCalledTimes(2);
  });

  it('ne cherche que les échéances des 30 prochains jours, et les abonnements ACTIFS', async () => {
    await rappelerEcheances();

    const where = AbonnementSouscrit.findAll.mock.calls[0][0].where;
    expect(where.statut).toBe('active');
    const [debut, fin] = where.date_fin[Object.getOwnPropertySymbols(where.date_fin)[0]];
    expect(Math.round((fin - debut) / JOUR)).toBe(30);
  });

  it('une organisation sans compte de facturation ne fait pas échouer la tâche', async () => {
    Utilisateur.findAll.mockResolvedValue([]);
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(7)]);

    await expect(rappelerEcheances()).resolves.toBeUndefined();
    expect(NotificationService.notifier).not.toHaveBeenCalled();
  });
});

describe('le courriel', () => {
  it('double la notification : le signataire n’ouvre pas l’application chaque jour', async () => {
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await rappelerEcheances();

    expect(sendEcheanceAbonnementEmail).toHaveBeenCalledTimes(1);
    expect(sendEcheanceAbonnementEmail.mock.calls[0][0]).toMatchObject({
      to: ['patron@example.com'],
      variante: 'approche',
      prenom: 'Balla',
      organisationNom: 'Widjila BTP',
      planNom: 'Pro',
      jours: 7,
      limiteChantiers: LIMITE_CHANTIERS,
      limiteUtilisateurs: LIMITE_UTILISATEURS,
    });
  });

  it('part à TOUS ceux qui peuvent reconduire, en un seul envoi', async () => {
    // Un responsable en congé ne doit pas suffire à laisser passer une
    // échéance. Et sans prénom : « Bonjour Balla » à trois personnes sonne faux.
    Utilisateur.findAll.mockResolvedValue([
      titulaire,
      { id: 'u2', email: 'dg@example.com', prenom: 'Awa' },
    ]);
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await rappelerEcheances();

    expect(sendEcheanceAbonnementEmail).toHaveBeenCalledTimes(1);
    const envoi = sendEcheanceAbonnementEmail.mock.calls[0][0];
    expect(envoi.to).toEqual(['patron@example.com', 'dg@example.com']);
    expect(envoi.prenom).toBeNull();
  });

  it('n’est pas renvoyé quand le palier a déjà été notifié', async () => {
    NotificationService.dejaNotifie.mockResolvedValue(true);
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await rappelerEcheances();

    expect(sendEcheanceAbonnementEmail).not.toHaveBeenCalled();
  });

  it('un SMTP en panne ne fait échouer ni la tâche ni la notification', async () => {
    // La notification est déjà partie, et c'est elle qui porte la trace :
    // un courriel perdu ne doit pas faire rejouer le rappel le lendemain.
    sendEcheanceAbonnementEmail.mockRejectedValue(new Error('SMTP injoignable'));
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await expect(rappelerEcheances()).resolves.toBeUndefined();
    expect(NotificationService.notifier).toHaveBeenCalledTimes(1);
  });

  it('un compte sans adresse n’empêche pas l’envoi aux autres', async () => {
    Utilisateur.findAll.mockResolvedValue([
      { id: 'u3', email: null, prenom: 'Sans' },
      titulaire,
    ]);
    AbonnementSouscrit.findAll.mockResolvedValue([souscription(6)]);

    await rappelerEcheances();

    expect(sendEcheanceAbonnementEmail.mock.calls[0][0].to).toEqual(['patron@example.com']);
  });

  it('annonce l’échéance passée après la clôture', async () => {
    AbonnementSouscrit.findAll.mockResolvedValue([
      souscription(-1, { date_fin: new Date(Date.now() - JOUR) }),
    ]);

    await cloturerEchus();

    expect(sendEcheanceAbonnementEmail.mock.calls[0][0]).toMatchObject({
      variante: 'expire',
      planNom: 'Pro',
    });
  });
});

describe('la clôture des abonnements échus', () => {
  it('passe la souscription à `expiree` et désabonne l’organisation', async () => {
    const s = souscription(-1, { date_fin: new Date(Date.now() - JOUR) });
    AbonnementSouscrit.findAll.mockResolvedValue([s]);

    const nombre = await cloturerEchus();

    expect(nombre).toBe(1);
    expect(s.statut).toBe('expiree');
    // `is_subscribed` et le libellé de formule suivent : ce sont eux que
    // lisent les écrans et `checkSubscription`.
    expect(SubscriptionService._synchroniserOrganisation).toHaveBeenCalledWith(s);
  });

  it('prévient que les données restent accessibles', async () => {
    AbonnementSouscrit.findAll.mockResolvedValue([
      souscription(-1, { date_fin: new Date(Date.now() - JOUR) }),
    ]);

    await cloturerEchus();

    const envoi = NotificationService.notifier.mock.calls[0][0];
    expect(envoi.type).toBe('abonnement.expire');
    expect(envoi.message).toMatch(/restent accessibles/i);
    expect(envoi.message).toMatch(/offre gratuite/i);
  });

  it('ne clôture que ce qui est ÉCHU, et une seule fois', async () => {
    await cloturerEchus();

    const where = AbonnementSouscrit.findAll.mock.calls[0][0].where;
    expect(where.statut).toBe('active');
    const borne = where.date_fin[Object.getOwnPropertySymbols(where.date_fin)[0]];
    expect(borne.getTime()).toBeLessThanOrEqual(Date.now());

    // Deuxième passage : la notification existe déjà, rien n'est réémis.
    NotificationService.dejaNotifie.mockResolvedValue(true);
    AbonnementSouscrit.findAll.mockResolvedValue([
      souscription(-1, { date_fin: new Date(Date.now() - JOUR) }),
    ]);
    await cloturerEchus();
    expect(NotificationService.notifier).not.toHaveBeenCalled();
  });
});

describe('les devis périmés', () => {
  it('referme ceux que le client n’a pas traités', async () => {
    Devis.update.mockResolvedValue([3]);

    const nombre = await fermerDevisPerimes();

    expect(nombre).toBe(3);
    const [valeurs, options] = Devis.update.mock.calls[0];
    expect(valeurs).toEqual({ statut: 'expire' });
    // Un devis ACCEPTÉ ou REFUSÉ n'est jamais « expiré » : il a été traité.
    const statuts = options.where.statut[Object.getOwnPropertySymbols(options.where.statut)[0]];
    expect(statuts).toEqual(['brouillon', 'envoye']);
  });
});
