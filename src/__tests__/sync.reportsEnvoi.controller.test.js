'use strict';

/**
 * Audit synchronisation — l'en-tête `Idempotency-Key` de l'envoi de rapport.
 *
 * Le service fait l'essentiel (voir sync.rapportEnvoi.idempotence.test.js) ;
 * ce test verrouille le CONTRAT HTTP que le mobile consomme :
 *   - la clé est lue dans l'en-tête, et seulement là ;
 *   - une clé malformée est refusée avant tout envoi ;
 *   - « envoi déjà en cours » part en 409 avec le code `ENVOI_EN_COURS`, que
 *     le mobile classe en échec TEMPORAIRE (jamais définitif).
 */

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());
jest.mock('../modules/rapport/service/rapportEnvoi.service.js', () => ({
  envoyer: jest.fn(),
  preparer: jest.fn(),
  destinataires: jest.fn(),
}));
jest.mock('../utils/organisationRequete.js', () => ({
  organisationCible: jest.fn(async () => 'org-1'),
  estSuperAdmin: jest.fn(() => false),
}));

const RapportEnvoiService = require('../modules/rapport/service/rapportEnvoi.service.js');
const controleur = require('../modules/rapport/controller/reports.controller.js');

function requete(entetes = {}, body = { mode: 'lien' }) {
  const bas = Object.fromEntries(Object.entries(entetes).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    params: { id: 'rap-1' },
    body,
    user: { id: 'u-1', role: 'ChefProjet', organisationId: 'org-1' },
    get: (nom) => bas[nom.toLowerCase()],
  };
}

function reponse() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  RapportEnvoiService.envoyer.mockResolvedValue({ success: true, message: 'Envoyé', envoi: { rapportId: 'rap-1' } });
});

it('transmet la clé de l’en-tête au service', async () => {
  const res = reponse();
  await controleur.envoyer(requete({ 'Idempotency-Key': 'act-12345678' }), res, jest.fn());

  expect(RapportEnvoiService.envoyer).toHaveBeenCalledWith(
    'rap-1', 'org-1', 'u-1', expect.objectContaining({ cleIdempotence: 'act-12345678', mode: 'lien' }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

it('sans en-tête, aucune clé n’est inventée', async () => {
  await controleur.envoyer(requete(), reponse(), jest.fn());

  expect(RapportEnvoiService.envoyer.mock.calls[0][3]).not.toHaveProperty('cleIdempotence');
});

it('une clé glissée dans le CORPS est écartée : l’en-tête seul fait foi', async () => {
  await controleur.envoyer(requete({}, { mode: 'lien', cleIdempotence: 'injectee-par-le-corps' }), reponse(), jest.fn());

  const options = RapportEnvoiService.envoyer.mock.calls[0][3];
  expect(options).not.toHaveProperty('cleIdempotence');
  expect(options.mode).toBe('lien');
});

it('l’en-tête l’emporte sur une clé du corps', async () => {
  await controleur.envoyer(
    requete({ 'Idempotency-Key': 'act-12345678' }, { cleIdempotence: 'injectee-par-le-corps' }), reponse(), jest.fn(),
  );

  expect(RapportEnvoiService.envoyer.mock.calls[0][3].cleIdempotence).toBe('act-12345678');
});

it.each(['court', 'avec espace dedans', 'x'.repeat(129), 'clé-accentuée-é'])(
  'refuse la clé malformée « %s » sans rien envoyer', async (cle) => {
    const next = jest.fn();
    await controleur.envoyer(requete({ 'Idempotency-Key': cle }), reponse(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(RapportEnvoiService.envoyer).not.toHaveBeenCalled();
  },
);

it('un envoi déjà en cours répond 409 avec le code ENVOI_EN_COURS', async () => {
  RapportEnvoiService.envoyer.mockResolvedValue({
    success: false, statusCode: 409, code: 'ENVOI_EN_COURS', message: 'Déjà en cours',
  });
  const next = jest.fn();

  await controleur.envoyer(requete({ 'Idempotency-Key': 'act-12345678' }), reponse(), next);

  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'ENVOI_EN_COURS' }));
});

it('un rejeu est signalé dans la réponse', async () => {
  RapportEnvoiService.envoyer.mockResolvedValue({ success: true, rejeu: true, message: 'Déjà envoyé', envoi: {} });
  const res = reponse();

  await controleur.envoyer(requete({ 'Idempotency-Key': 'act-12345678' }), res, jest.fn());

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rejeu: true }) }));
});
