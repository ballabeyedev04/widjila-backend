'use strict';

/**
 * Tests — envoi d'e-mails : délai, disjoncteur, journal sans données personnelles.
 *
 * Défauts reproduits :
 *   - le SDK Resend appelle `fetch` sans délai : un fournisseur muet retenait
 *     la requête de l'utilisateur sans limite ;
 *   - pendant une panne, chaque envoi repayait le délai complet ;
 *   - l'objet du courriel — qui contient parfois une adresse (« Demande de
 *     suppression de compte — jean@… ») — était écrit tel quel au journal.
 */

jest.mock('resend', () => {
  const send = jest.fn();
  return { Resend: jest.fn().mockImplementation(() => ({ emails: { send } })), __send: send };
});

process.env.RESEND_API_KEY = 're_test';
process.env.EMAIL_TIMEOUT_MS = '60';

/** Module neuf à chaque test : le disjoncteur repart fermé. */
function charger() {
  const m = {};
  jest.isolateModules(() => {
    m.email = require('../infrastructure/emailService.js');
    m.send = require('resend').__send;
    m.logger = require('../utils/logger.js');
  });
  jest.spyOn(m.logger, 'info').mockImplementation(() => m.logger);
  jest.spyOn(m.logger, 'error').mockImplementation(() => m.logger);
  jest.spyOn(m.logger, 'warn').mockImplementation(() => m.logger);
  m.send.mockReset();
  return m;
}

const message = { to: 'dest@exemple.fr', subject: 'Votre rapport', html: '<p>x</p>' };

it('un fournisseur qui ne répond pas fait échouer l’envoi en 503 DELAI_DEPASSE, rapidement', async () => {
  const { email, send } = charger();
  send.mockImplementation(() => new Promise(() => {}));

  const debut = Date.now();
  const err = await email.sendEmail(message).catch((e) => e);

  expect(err.code).toBe('DELAI_DEPASSE');
  expect(err.statusCode).toBe(503);
  expect(Date.now() - debut).toBeLessThan(1000);
});

it('panne du fournisseur : après 5 échecs, les envois échouent sans l’appeler', async () => {
  const { email, send } = charger();
  send.mockResolvedValue({ data: null, error: { statusCode: 500, name: 'internal_server_error', message: 'boom' } });

  for (let i = 0; i < 5; i += 1) await expect(email.sendEmail(message)).rejects.toThrow('boom');
  const err = await email.sendEmail(message).catch((e) => e);

  expect(err.code).toBe('SERVICE_EXTERNE_INDISPONIBLE');
  expect(send).toHaveBeenCalledTimes(5);
});

it('des adresses refusées (422) ne coupent pas l’envoi pour tout le monde', async () => {
  const { email, send } = charger();
  send.mockResolvedValue({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field' } });

  for (let i = 0; i < 10; i += 1) await email.sendEmail(message).catch(() => {});

  expect(send).toHaveBeenCalledTimes(10);
  expect(email.disjoncteurEmail.etatCourant().etat).toBe('ferme');
});

it('le journal ne contient aucune adresse complète, ni dans l’objet ni dans l’échec', async () => {
  const { email, send, logger } = charger();
  send.mockResolvedValueOnce({ data: { id: 'm-1' }, error: null });
  send.mockResolvedValueOnce({ data: null, error: { statusCode: 500, name: 'x', message: 'boom' } });
  const sujet = 'Demande de suppression de compte — jean.dupont@client.fr';

  await email.sendEmail({ ...message, subject: sujet });
  await email.sendEmail({ ...message, subject: sujet }).catch(() => {});

  const succes = logger.info.mock.calls.map((c) => c[0]).join('\n');
  const echec = JSON.stringify(logger.error.mock.calls);
  expect(succes).toContain('*@client.fr');
  expect(succes).not.toMatch(/jean\.dupont|dest@/);
  expect(echec).not.toMatch(/jean\.dupont|dest@/);
  expect(echec).toContain('"statutHttp":500');
});

it('sans clé API, l’envoi reste un no-op silencieux (comportement de développement)', async () => {
  const cle = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const { email, send } = charger();
    await expect(email.sendEmail(message)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  } finally {
    process.env.RESEND_API_KEY = cle;
  }
});
