'use strict';

/**
 * Tests — audit de sécurité : authentification et comptes.
 *
 *  1. MFA : un secret ACTIF ne se remplace pas par `activer` (sinon un jeton
 *     d'accès volé suffisait à substituer au second facteur de la victime un
 *     secret choisi par l'attaquant, sans code de l'ancien).
 *  2. Modèle utilisateur : aucune sérialisation JSON n'expose le hash du mot
 *     de passe ni le secret TOTP (déchiffré par son getter).
 *  3. Courriel OTP : le prénom est échappé.
 *  4. /account/chantiers exige un compte ACTIF.
 */

// otplib est publié en ESM : doublé, comme dans les autres suites.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'SECRET-NEUF'),
  generateURI: jest.fn(() => 'otpauth://totp/x'),
  verifySync: jest.fn(() => ({ valid: true })),
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn(async () => 'data:image/png;base64,') }));

const MfaService = require('../modules/auth/service/mfa.service.js');

describe('MfaService.activer — pas de remplacement d’un MFA actif', () => {
  it('refuse quand le MFA est déjà actif, sans toucher au secret', async () => {
    const utilisateur = { mfa_active: true, mfa_secret: 'ANCIEN', update: jest.fn() };

    const res = await MfaService.activer(utilisateur, { code: '123456', secret: 'SECRET-ATTAQUANT' });

    expect(res.success).toBe(false);
    expect(utilisateur.update).not.toHaveBeenCalled();
  });

  it('active normalement quand le MFA est inactif et le code valide', async () => {
    const utilisateur = { mfa_active: false, update: jest.fn().mockResolvedValue() };

    const res = await MfaService.activer(utilisateur, { code: '123456', secret: 'SECRET' });

    expect(res.success).toBe(true);
    expect(utilisateur.update).toHaveBeenCalledWith({ mfa_secret: 'SECRET', mfa_active: true });
  });
});

describe('Utilisateur.toJSON — secrets jamais sérialisés', () => {
  const User = require('../models/utilisateur.model.js');

  it('retire hash, secret TOTP, version de jeton et compteurs anti force-brute', () => {
    const u = User.build({
      nom: 'Diop', prenom: 'Awa', email: 'awa@exemple.test',
      mot_de_passe: '$2b$12$hash', mfa_secret: 'JBSWY3DPEHPK3PXP', mfa_active: true,
      token_version: 4, tentatives_connexion: 2, compte_bloque_jusqua: new Date(),
    });

    const json = JSON.parse(JSON.stringify(u));

    for (const cle of User.COLONNES_SECRETES) expect(json).not.toHaveProperty(cle);
    expect(json.email).toBe('awa@exemple.test');
    expect(json.mfa_active).toBe(true);
  });
});

describe('Courriel OTP — prénom échappé', () => {
  const template = require('../templates/mail/otpPassword.template.js');

  it('neutralise une balise glissée dans le prénom', () => {
    const html = template({ nom: '<a href="https://piege.test">Cliquez</a>', otp: 'AB23CD' });

    expect(html).not.toContain('<a href="https://piege.test">');
    expect(html).toContain('&lt;a href=');
    expect(html).toContain('AB23CD');
  });
});

describe('Envoi de rapports par courriel — anti relais de spam', () => {
  const { envoyerRapportSchema } = require('../modules/rapport/validation/rapport.validation.js');

  it('refuse un objet sur plusieurs lignes (injection d’en-têtes)', () => {
    const { error } = envoyerRapportSchema.validate({ objet: 'Rapport\r\nBcc: victime@exemple.test' });
    expect(error).toBeDefined();
  });

  it('accepte un objet d’une ligne', () => {
    const { error } = envoyerRapportSchema.validate({ objet: 'Rapport de réserves — semaine 36' });
    expect(error).toBeUndefined();
  });

  it.each([
    ['rapport.route.js', "'/rapports/:id/envoi'"],
    ['reports.route.js', "'/reports/:id/send-email', ...gardesPilote"],
  ])('%s plafonne les envois par utilisateur', (fichier, repere) => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'modules', 'rapport', 'route', fichier), 'utf8'
    );
    const debut = src.indexOf(repere);
    expect(debut).toBeGreaterThan(-1);
    expect(src.slice(debut, debut + 400)).toContain('envoiRapportRateLimit');
  });
});

describe('/account/chantiers — compte actif exigé', () => {
  it('pose checkActiveUser sur la route', () => {
    const router = require('../modules/account/route/account.route.js');
    const couche = router.stack.find((l) => l.route && l.route.path === '/chantiers');
    const noms = couche.route.stack.map((s) => s.handle.name);
    expect(noms).toContain('checkActiveUser');
  });
});
