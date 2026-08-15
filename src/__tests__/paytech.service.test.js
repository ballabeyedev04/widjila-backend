'use strict';

/**
 * Tests — modules/paytech/service/paytech.service.js (audit — Bugs & fiabilité
 * §1 : c'est la vérification de signature du webhook de PAIEMENT, exposée sur
 * une route PUBLIQUE `POST /paytech/ipn`. Une régression ici est soit un vrai
 * paiement jamais crédité, soit — pire — un abonnement activé sans paiement
 * réel.
 *
 * `paytech.service.js` exporte un SINGLETON dont les clés sont lues depuis
 * `process.env` au moment du `require` (dans le constructeur). On isole donc
 * chaque scénario de configuration avec `jest.resetModules()` + un nouveau
 * `require()`, plutôt que de dépendre de l'ordre d'exécution des tests.
 */

const ENV_BASE = { ...process.env };

function chargerServiceAvecEnv(overrides) {
  jest.resetModules();
  process.env = { ...ENV_BASE, ...overrides };
  // eslint-disable-next-line global-require
  return require('../modules/paytech/service/paytech.service.js');
}

afterEach(() => {
  process.env = { ...ENV_BASE };
});

describe('PayTechService — vérification HMAC du webhook IPN', () => {
  test('isConfigured() est false sans clés API', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: '', PAYTECH_API_SECRET: '' });
    expect(service.isConfigured()).toBe(false);
  });

  test('verifyIpn() refuse sans lever si les clés ne sont pas configurées', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: '', PAYTECH_API_SECRET: '' });
    expect(() => service.verifyIpn({ item_price: 1000, ref_command: 'x', hmac_compute: 'peu-importe' }))
      .not.toThrow();
    expect(service.verifyIpn({ item_price: 1000, ref_command: 'x', hmac_compute: 'peu-importe' })).toBe(false);
  });

  test('accepte un HMAC correctement calculé', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    const hmacValide = service.computeHmac(5000, 'REF-001');
    expect(service.verifyIpn({ item_price: 5000, ref_command: 'REF-001', hmac_compute: hmacValide })).toBe(true);
  });

  test('rejette un HMAC valide mais pour un montant différent', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    const hmacPour5000 = service.computeHmac(5000, 'REF-001');
    // Même signature, mais présentée pour un montant manipulé : doit être rejetée.
    expect(service.verifyIpn({ item_price: 999999, ref_command: 'REF-001', hmac_compute: hmacPour5000 })).toBe(false);
  });

  test('rejette un HMAC signé avec un mauvais secret', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    const crypto = require('crypto');
    const faux = crypto.createHmac('sha256', 'mauvais_secret')
      .update(`5000|REF-001|cle_test`)
      .digest('hex');
    expect(service.verifyIpn({ item_price: 5000, ref_command: 'REF-001', hmac_compute: faux })).toBe(false);
  });

  // Régression du bug documenté dans le fichier source : `hmac_compute`
  // absent/numérique/de longueur différente ne doit JAMAIS lever une
  // exception (RangeError de timingSafeEqual, TypeError de Buffer.from).
  test.each([
    ['hmac_compute absent', undefined],
    ['hmac_compute numérique', 123456],
    ['hmac_compute vide', ''],
    ['hmac_compute trop court', 'abcd'],
    ['hmac_compute null', null],
  ])('ne lève jamais pour %s — renvoie false proprement', (_label, valeur) => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    expect(() => service.verifyIpn({ item_price: 5000, ref_command: 'REF-001', hmac_compute: valeur }))
      .not.toThrow();
  });

  test('verifySha256() accepte des hash valides des deux clés', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    const crypto = require('crypto');
    const keySha = crypto.createHash('sha256').update('cle_test').digest('hex');
    const secretSha = crypto.createHash('sha256').update('secret_test').digest('hex');
    expect(service.verifySha256(keySha, secretSha)).toBe(true);
  });

  test('verifySha256() rejette si un seul des deux hash est faux', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'cle_test', PAYTECH_API_SECRET: 'secret_test' });
    const crypto = require('crypto');
    const keySha = crypto.createHash('sha256').update('cle_test').digest('hex');
    expect(service.verifySha256(keySha, 'hash_arbitraire_de_64_caracteres_hexadecimaux_pour_la_longueur1')).toBe(false);
  });

  test('generateRefCommand() reste sous 64 caractères (contrainte PayTech)', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'k', PAYTECH_API_SECRET: 's' });
    const ref = service.generateRefCommand('11111111-1111-1111-1111-111111111111', 'plan-entreprise-premium');
    expect(ref.length).toBeLessThanOrEqual(64);
  });

  test('encodeCustomField() / decodeCustomField() sont symétriques', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'k', PAYTECH_API_SECRET: 's' });
    const donnees = { organisationId: 'org-1', planId: 'pro' };
    expect(service.decodeCustomField(service.encodeCustomField(donnees))).toEqual(donnees);
  });

  test('decodeCustomField() renvoie null sur une entrée corrompue plutôt que de lever', () => {
    const service = chargerServiceAvecEnv({ PAYTECH_API_KEY: 'k', PAYTECH_API_SECRET: 's' });
    expect(service.decodeCustomField('%%% pas du base64 %%%')).toBeNull();
  });
});
