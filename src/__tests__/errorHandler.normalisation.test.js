'use strict';

/**
 * Tests — le gestionnaire d'erreurs distingue « réessayez » de « bug ».
 *
 * Défaut reproduit : seuls quatre noms d'erreurs de connexion étaient
 * reconnus. Un pool épuisé (`SequelizeConnectionAcquireTimeoutError`), le cas
 * le plus fréquent sous charge, répondait 500 « Erreur interne » : le client
 * concluait à un bug, le mobile marquait l'action hors ligne en échec au lieu
 * de la retenter, et la supervision mélangeait saturation et régression.
 *
 * Vérifié aussi : format uniforme (`error.code`, `requestId`) SANS casser les
 * champs historiques, niveaux de journal (5xx en error, 4xx en info), et le
 * cas d'une réponse déjà partiellement envoyée.
 */

const {
  ConnectionAcquireTimeoutError, ConnectionRefusedError, HostNotFoundError, DatabaseError,
} = require('sequelize');
const errorHandler = require('../middlewares/errorHandler.middleware.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');
const {
  ForbiddenError, ValidationError, ServiceIndisponibleError, NotFoundError,
} = require('../errors/AppError.js');

function faireReponse({ headersSent = false } = {}) {
  const r = { code: null, corps: null, entetes: {}, headersSent };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.corps = b; return r; };
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v; };
  return r;
}

const requete = {
  id: 'req-test-0001', method: 'GET', originalUrl: '/api/v1/chantiers?token=secret', path: '/api/v1/chantiers', ip: '10.0.0.1',
};

function traiter(err, options) {
  const res = faireReponse(options);
  const next = jest.fn();
  errorHandler(err, requete, res, next);
  return { res, next };
}

function erreurSql(code, message) {
  return new DatabaseError(Object.assign(new Error(message), { code, sql: 'SELECT 1' }));
}

beforeEach(() => metrics.reinitialiser());

describe('base de données indisponible → 503 + Retry-After', () => {
  it.each([
    ['pool épuisé', () => new ConnectionAcquireTimeoutError(new Error('Operation timeout'))],
    ['connexion refusée', () => new ConnectionRefusedError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))],
    ['hôte introuvable', () => new HostNotFoundError(new Error('getaddrinfo ENOTFOUND db'))],
    ['requête annulée par statement_timeout', () => erreurSql('57014', 'canceling statement due to statement timeout')],
    ['serveur en arrêt', () => erreurSql('57P01', 'terminating connection due to administrator command')],
    ['trop de connexions', () => erreurSql('53300', 'sorry, too many clients already')],
  ])('%s', (_, fabriquer) => {
    const { res } = traiter(fabriquer());

    expect(res.code).toBe(503);
    expect(res.entetes['retry-after']).toBe('5');
    expect(res.corps.error.code).toBe('BASE_INDISPONIBLE');
    expect(res.corps.message).toBe('Service temporairement indisponible');
    // Aucun détail interne ne fuit.
    expect(JSON.stringify(res.corps)).not.toMatch(/5432|ECONNREFUSED|statement|clients|ENOTFOUND/);
  });

  it('une vraie erreur SQL (colonne absente) reste un 500', () => {
    const { res } = traiter(erreurSql('42703', 'column "x" does not exist'));

    expect(res.code).toBe(500);
    expect(res.corps.error.code).toBe('ERREUR_INTERNE');
  });
});

describe('format uniforme, compatible avec les clients existants', () => {
  it('garde message/code au premier niveau pour un code métier explicite', () => {
    const { res } = traiter(new ForbiddenError('Essai terminé', 'SUBSCRIPTION_REQUIRED', { trialEnded: true }));

    expect(res.code).toBe(403);
    expect(res.corps).toMatchObject({
      success: false,
      message: 'Essai terminé',
      code: 'SUBSCRIPTION_REQUIRED',
      error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Essai terminé', details: { trialEnded: true } },
      requestId: 'req-test-0001',
    });
    // Le troisième argument de ForbiddenError était PERDU : il arrive désormais.
    expect(res.corps.details).toBeUndefined(); // premier niveau : tableaux seulement, comme avant
  });

  it('garde `details` (tableau) au premier niveau pour la validation', () => {
    const { res } = traiter(new ValidationError('Données invalides', ['"nom" est requis']));

    expect(res.code).toBe(422);
    expect(res.corps.details).toEqual(['"nom" est requis']);
    expect(res.corps.error.code).toBe('DONNEES_INVALIDES');
    expect(res.corps.code).toBeUndefined();
  });

  it('respecte le délai de reprise annoncé par une dépendance', () => {
    const { res } = traiter(new ServiceIndisponibleError('Service e-mail indisponible', 'SERVICE_EXTERNE_INDISPONIBLE', { reessayerDansS: 42 }));

    expect(res.code).toBe(503);
    expect(res.entetes['retry-after']).toBe('42');
    expect(res.corps.code).toBe('SERVICE_EXTERNE_INDISPONIBLE');
  });

  it('compte chaque code dans les métriques', () => {
    traiter(new NotFoundError());
    traiter(new NotFoundError());

    expect(metrics.instantane().erreurs.RESSOURCE_INTROUVABLE).toBe(2);
  });
});

describe('journal', () => {
  it('une erreur client est écrite en info, sans pile', () => {
    const log = jest.spyOn(logger, 'log');

    traiter(new NotFoundError('Chantier introuvable'));

    const [niveau, , contexte] = log.mock.calls[0];
    expect(niveau).toBe('info');
    expect(contexte.stack).toBeUndefined();
    expect(contexte.requestId).toBe('req-test-0001');
  });

  it('une erreur serveur est écrite en error, avec la pile et la cause SQL, et l’URL masquée', () => {
    const log = jest.spyOn(logger, 'log');

    traiter(erreurSql('42703', 'column "x" does not exist'));

    const [niveau, , contexte] = log.mock.calls[0];
    expect(niveau).toBe('error');
    expect(contexte.stack).toBeDefined();
    expect(contexte.causeSql).toEqual({ code: '42703', message: 'column "x" does not exist' });
    expect(contexte.chemin).not.toMatch(/secret/);
  });
});

it('réponse déjà partiellement envoyée : délègue à Express au lieu d’écrire un corps', () => {
  const err = new Error('flux interrompu');
  const { res, next } = traiter(err, { headersSent: true });

  expect(next).toHaveBeenCalledWith(err);
  expect(res.corps).toBeNull();
});
