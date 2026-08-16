'use strict';

/**
 * Tests — middlewares/auditTrail.middleware.js (audit — élargissement du
 * journal d'audit à toutes les actions, pas seulement le super-admin
 * plateforme). AuditLogService est mocké : on teste uniquement la LOGIQUE
 * de décision (quand journaliser, avec quel action/cible/ip), pas l'écriture
 * en base elle-même (déjà couverte par le service lui-même).
 */

jest.mock('../modules/admin/service/auditLog.service.js', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}));

const AuditLogService = require('../modules/admin/service/auditLog.service.js');
const auditTrail = require('../middlewares/auditTrail.middleware.js');

/** Simule res.on('finish', cb) sans dépendre d'un vrai objet Response Express. */
function fakeRes(statusCode = 200) {
  const listeners = {};
  return {
    statusCode,
    on: jest.fn((event, cb) => { listeners[event] = cb; }),
    _trigger: (event) => listeners[event] && listeners[event](),
  };
}

function runMiddleware({
  method = 'POST', originalUrl = '/api/v1/chantiers', route, baseUrl = '',
  params = {}, user, statusCode = 200, ip = '203.0.113.7',
}) {
  const req = { method, originalUrl, route, baseUrl, params, user, ip };
  const res = fakeRes(statusCode);
  const next = jest.fn();
  auditTrail(req, res, next);
  res._trigger('finish'); // simule la fin réelle de la réponse HTTP
  return { req, res, next };
}

describe('auditTrail.middleware', () => {
  beforeEach(() => {
    AuditLogService.logAction.mockClear();
  });

  test('laisse toujours passer la requête (jamais bloquante)', () => {
    const { next } = runMiddleware({ method: 'GET', user: { id: 'u1' } });
    expect(next).toHaveBeenCalledWith();
  });

  test('ignore les méthodes non mutantes (GET/HEAD)', () => {
    runMiddleware({ method: 'GET', user: { id: 'u1' } });
    expect(AuditLogService.logAction).not.toHaveBeenCalled();
  });

  test('ignore les routes /admin/* — déjà journalisées manuellement (détail plus riche)', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/admin/utilisateurs', baseUrl: '/api/v1/admin/utilisateurs',
      route: { path: '/' }, user: { id: 'u1' },
    });
    expect(AuditLogService.logAction).not.toHaveBeenCalled();
  });

  test('ignore les routes /auth/* — déjà couvertes par connexionLog.service.js', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/auth/login', baseUrl: '/api/v1/auth',
      route: { path: '/login' }, user: { id: 'u1' },
    });
    expect(AuditLogService.logAction).not.toHaveBeenCalled();
  });

  test('ignore une action mutante sans utilisateur authentifié (rien à attribuer)', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/chantiers', baseUrl: '/api/v1/chantiers',
      route: { path: '/' }, user: undefined,
    });
    expect(AuditLogService.logAction).not.toHaveBeenCalled();
  });

  test('ignore une action mutante en échec (statusCode >= 400)', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/chantiers', baseUrl: '/api/v1/chantiers',
      route: { path: '/' }, user: { id: 'u1' }, statusCode: 422,
    });
    expect(AuditLogService.logAction).not.toHaveBeenCalled();
  });

  test('journalise une création réussie avec admin et IP corrects', () => {
    const user = { id: 'u1', nom: 'Beye', prenom: 'Balla', email: 'b@x.com' };
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/chantiers', baseUrl: '/api/v1/chantiers',
      route: { path: '/' }, user, statusCode: 201, ip: '198.51.100.20',
    });
    expect(AuditLogService.logAction).toHaveBeenCalledWith(expect.objectContaining({
      admin: user,
      action: 'chantiers.create',
      ip: '198.51.100.20',
      details: null,
    }));
  });

  test('dérive un nom d\'action à plusieurs segments et retire les paramètres de route', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/chantiers/chantier-1/membres', baseUrl: '/api/v1/chantiers',
      route: { path: '/:id/membres' }, params: { id: 'chantier-1' }, user: { id: 'u1' },
    });
    const arg = AuditLogService.logAction.mock.calls[0][0];
    expect(arg.action).toBe('chantiers.membres.create');
  });

  test('PUT/PATCH → verbe "update", DELETE → verbe "delete"', () => {
    runMiddleware({
      method: 'PUT', originalUrl: '/api/v1/chantiers/chantier-1', baseUrl: '/api/v1/chantiers',
      route: { path: '/:id' }, params: { id: 'chantier-1' }, user: { id: 'u1' },
    });
    expect(AuditLogService.logAction.mock.calls[0][0].action).toBe('chantiers.update');

    AuditLogService.logAction.mockClear();
    runMiddleware({
      method: 'DELETE', originalUrl: '/api/v1/chantiers/chantier-1', baseUrl: '/api/v1/chantiers',
      route: { path: '/:id' }, params: { id: 'chantier-1' }, user: { id: 'u1' },
    });
    expect(AuditLogService.logAction.mock.calls[0][0].action).toBe('chantiers.delete');
  });

  test('déduit cibleType/cibleId depuis le premier paramètre "*Id" rencontré', () => {
    runMiddleware({
      method: 'DELETE', originalUrl: '/api/v1/chantiers/chantier-1/reserves/reserve-9',
      baseUrl: '/api/v1', route: { path: '/chantiers/:chantierId/reserves/:reserveId' },
      params: { chantierId: 'chantier-1', reserveId: 'reserve-9' }, user: { id: 'u1' },
    });
    const arg = AuditLogService.logAction.mock.calls[0][0];
    expect(arg.cibleType).toBe('chantier');
    expect(arg.cibleId).toBe('chantier-1');
  });

  test('paramètre nommé juste "id" → cibleType générique "ressource"', () => {
    runMiddleware({
      method: 'DELETE', originalUrl: '/api/v1/chantiers/chantier-1', baseUrl: '/api/v1/chantiers',
      route: { path: '/:id' }, params: { id: 'chantier-1' }, user: { id: 'u1' },
    });
    const arg = AuditLogService.logAction.mock.calls[0][0];
    expect(arg.cibleType).toBe('ressource');
    expect(arg.cibleId).toBe('chantier-1');
  });

  test('aucun paramètre "*Id" dans la route → cibleType/cibleId null', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/notifications/broadcast', baseUrl: '/api/v1/notifications',
      route: { path: '/broadcast' }, params: {}, user: { id: 'u1' },
    });
    const arg = AuditLogService.logAction.mock.calls[0][0];
    expect(arg.cibleType).toBeNull();
    expect(arg.cibleId).toBeNull();
  });

  test('sans req.route (fallback), utilise le chemin réel sans lever d\'erreur', () => {
    runMiddleware({
      method: 'POST', originalUrl: '/api/v1/chantiers', baseUrl: '/api/v1/chantiers',
      route: undefined, user: { id: 'u1' },
    });
    expect(AuditLogService.logAction).toHaveBeenCalled();
  });
});
