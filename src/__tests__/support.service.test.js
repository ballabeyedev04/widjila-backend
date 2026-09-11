'use strict';

/**
 * Tests — « Contacter le support » depuis l'application.
 *
 * ## Ce qui manquait
 *
 * Le mobile affichait « Contacter le support — Bientôt disponible » : aucune
 * adresse n'était configurée, aucune route n'existait. La demande part
 * désormais du formulaire de l'application, le serveur la transmet par email
 * à `SUPPORT_EMAIL` (à défaut `ADMIN_EMAIL`), avec l'utilisateur en réponse.
 */

jest.mock('../infrastructure/emailService.js', () => ({ sendEmail: jest.fn() }));
jest.mock('../models/index.js', () => ({ Organisation: { findByPk: jest.fn() } }));

const { sendEmail } = require('../infrastructure/emailService.js');
const { Organisation } = require('../models/index.js');
const SupportService = require('../modules/support/service/support.service.js');
const { envoyerMessageSupportSchema } = require('../modules/support/validation/support.validation.js');

const utilisateur = {
  id: 'u1',
  email: 'chef@exemple.test',
  prenom: 'Awa',
  nom: 'Diop',
  role: 'ChefProjet',
  organisationId: 'o1',
};

const demande = {
  sujet: 'Export bloqué',
  message: 'Le rapport ne se génère plus depuis ce matin.',
  contexte: { plateforme: 'android', version: '1.0.4 (12)' },
};

describe('SupportService.envoyerMessage', () => {
  const sauvegarde = {};

  beforeEach(() => {
    for (const cle of ['SUPPORT_EMAIL', 'ADMIN_EMAIL']) sauvegarde[cle] = process.env[cle];
    process.env.SUPPORT_EMAIL = 'support@widjila.test';
    Organisation.findByPk.mockResolvedValue({ id: 'o1', nom: 'BTP Dakar' });
    sendEmail.mockResolvedValue({ id: 'email-1' });
  });

  afterEach(() => {
    for (const [cle, valeur] of Object.entries(sauvegarde)) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
  });

  test('transmet la demande au support, la réponse revenant à l’utilisateur', async () => {
    const resultat = await SupportService.envoyerMessage(utilisateur, demande);

    expect(resultat.success).toBe(true);
    const envoi = sendEmail.mock.calls[0][0];
    expect(envoi.to).toBe('support@widjila.test');
    expect(envoi.replyTo).toBe('chef@exemple.test');
    expect(envoi.subject).toBe('[Support] Export bloqué');
    expect(envoi.html).toContain('BTP Dakar');
    expect(envoi.html).toContain('android · 1.0.4 (12)');
  });

  test('sans SUPPORT_EMAIL, la demande part à ADMIN_EMAIL', async () => {
    process.env.SUPPORT_EMAIL = '';
    process.env.ADMIN_EMAIL = 'admin@widjila.test';

    await SupportService.envoyerMessage(utilisateur, demande);

    expect(sendEmail.mock.calls[0][0].to).toBe('admin@widjila.test');
  });

  test('le contenu saisi est échappé', async () => {
    await SupportService.envoyerMessage(utilisateur, {
      sujet: 'Bug',
      message: '<script>alert(1)</script> et <a href="x">lien</a>',
    });

    const { html } = sendEmail.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('aucune adresse configurée : 503, rien n’est envoyé', async () => {
    process.env.SUPPORT_EMAIL = '';
    process.env.ADMIN_EMAIL = '';

    const resultat = await SupportService.envoyerMessage(utilisateur, demande);

    expect(resultat).toMatchObject({ success: false, statut: 503 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('fournisseur d’email absent : pas de faux « message envoyé »', async () => {
    sendEmail.mockResolvedValue(null);

    const resultat = await SupportService.envoyerMessage(utilisateur, demande);

    expect(resultat).toMatchObject({ success: false, statut: 503 });
  });

  test('échec du fournisseur : 502, message explicite', async () => {
    sendEmail.mockRejectedValue(new Error('quota dépassé'));

    const resultat = await SupportService.envoyerMessage(utilisateur, demande);

    expect(resultat).toMatchObject({ success: false, statut: 502 });
    expect(resultat.message).toMatch(/n’a pas pu être envoyé/);
  });
});

describe('envoyerMessageSupportSchema', () => {
  test('accepte une demande complète', () => {
    expect(envoyerMessageSupportSchema.validate(demande).error).toBeUndefined();
  });

  test('refuse un sujet sur plusieurs lignes (injection d’en-tête)', () => {
    const { error } = envoyerMessageSupportSchema.validate({ ...demande, sujet: 'Bug\nBcc: x@y.z' });
    expect(error).toBeDefined();
  });

  test('refuse un message vide ou trop court', () => {
    expect(envoyerMessageSupportSchema.validate({ ...demande, message: 'ok' }).error).toBeDefined();
  });
});
