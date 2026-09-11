'use strict';

/**
 * Tests — l'API attaquée DIRECTEMENT, sans l'interface d'administration.
 *
 * L'attaquant n'a que l'URL de l'API, son propre compte et son jeton. Il peut
 * modifier le rôle écrit dans le jeton, rejouer un jeton expiré, révoqué ou
 * d'un autre type, appeler n'importe quelle route. Aucune garde React ne
 * s'interpose : seul le backend décide.
 *
 * On monte l'application RÉELLE (app.js) ; seule la lecture de l'utilisateur
 * en base est doublée — c'est elle que le middleware d'authentification
 * consulte à chaque requête, et c'est précisément ce qui rend inopérant un
 * rôle falsifié dans le jeton.
 *
 * La liste des routes d'administration n'est pas écrite à la main : elle est
 * lue dans app.js et dans les routeurs montés sous /api/v1/admin. Une route
 * ajoutée demain y entre automatiquement.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stockage local jetable, jamais Cloudflare R2 en test.
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'api-directe-'));
process.env.UPLOAD_DIR = DOSSIER;
for (const cle of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  process.env[cle] = '';
}

jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verifySync: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
// Limiteurs neutralisés : toutes les requêtes partent de la même IP. Ils sont
// couverts par rateLimit.sharedStore.test.js. Un Proxy plutôt qu'une liste :
// TOUT limiteur exporté — y compris ceux ajoutés demain — devient un passe-
// plat, sans quoi app.js refuse de se monter (« argument handler must be a
// function ») dès qu'un nouveau limiteur apparaît.
jest.mock('../middlewares/rateLimit.middleware.js', () => {
  const passe = (req, res, next) => next();
  return new Proxy({}, { get: (_cible, cle) => (cle === '__esModule' ? undefined : passe) });
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app.js');
const Utilisateur = require('../models/utilisateur.model.js');
const { Organisation } = require('../models/index.js');
const { jwtConfig } = require('../config/security.js');

afterAll(() => fs.rmSync(DOSSIER, { recursive: true, force: true }));

const UUID = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';

/** Les comptes « en base ». */
const COMPTES = {
  client:    { id: 'u-client', role: 'Client', statut: 'actif', token_version: 0, organisationId: ORG },
  titulaire: { id: 'u-titulaire', role: 'Entreprise', statut: 'actif', token_version: 0, organisationId: ORG },
  inactif:   { id: 'u-inactif', role: 'ChefProjet', statut: 'inactif', token_version: 0, organisationId: ORG },
  attente:   { id: 'u-attente', role: 'Entreprise', statut: 'en_attente_validation', token_version: 0, organisationId: ORG },
  rejete:    { id: 'u-rejete', role: 'Entreprise', statut: 'rejete', token_version: 0, organisationId: ORG },
  admin:     { id: 'u-admin', role: 'Admin', statut: 'actif', token_version: 5, organisationId: null },
};

/** Jeton d'accès authentique (signé avec le vrai secret), surchargeable. */
const jeton = (compte, surcharge = {}, secret = jwtConfig.secret, options = { expiresIn: '5m' }) =>
  jwt.sign({ id: compte.id, role: compte.role, organisationId: compte.organisationId, tv: compte.token_version, ...surcharge }, secret, options);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

beforeEach(() => {
  jest.spyOn(Utilisateur, 'findByPk').mockImplementation(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { ...c } : null;
  });
  // Essai EN COURS : on veut voir la garde de RÔLE, pas le mur d'abonnement.
  // (Un `is_subscribed: true` ferait vérifier la souscription en base par
  // checkSubscription — hors de portée d'un test sans base.)
  jest.spyOn(Organisation, 'findByPk').mockResolvedValue({
    id: ORG, is_subscribed: false,
    trial_ends_at: new Date(Date.now() + 86400000),
  });
});

/** Toutes les routes montées sous /api/v1/admin, lues dans le code. */
function routesAdmin() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const montages = [...source.matchAll(/app\.use\(\s*'(\/api\/v1\/admin\/[^']*)'\s*,\s*(\w+)\s*\)/g)];
  return montages.flatMap(([, prefixe, variable]) => {
    const [, relatif] = source.match(new RegExp(`const\\s+${variable}\\s*=\\s*require\\('\\.([^']+)'\\)`));
    const routeur = require(path.join(__dirname, '..', relatif));
    return routeur.stack.filter((c) => c.route).flatMap((c) =>
      Object.keys(c.route.methods).map((methode) => [
        `${methode.toUpperCase()} ${prefixe}${c.route.path.replace(/:\w+/g, UUID)}`,
        methode,
        `${prefixe}${c.route.path.replace(/:\w+/g, UUID)}`.replace(/\/$/, ''),
      ]));
  });
}

const ADMIN = routesAdmin();

const appel = (methode, url, jetonAcces) => {
  const r = request(app)[methode](url);
  return jetonAcces ? r.set('Authorization', `Bearer ${jetonAcces}`) : r;
};

describe('périmètre', () => {
  it('toutes les routes d’administration sont couvertes', () => {
    // Garde-fou : si la lecture échouait, les tests suivants ne vérifieraient rien.
    expect(ADMIN.length).toBeGreaterThanOrEqual(25);
  });
});

describe('API d’administration plateforme', () => {
  it.each(ADMIN)('%s — sans jeton : 401', async (_l, methode, url) => {
    expect((await appel(methode, url)).status).toBe(401);
  });

  it.each(ADMIN)('%s — jeton d’un titulaire d’organisation : 403', async (_l, methode, url) => {
    expect((await appel(methode, url, jeton(COMPTES.titulaire))).status).toBe(403);
  });

  it.each(ADMIN)('%s — rôle « Admin » FALSIFIÉ dans le jeton d’un client : 403', async (_l, methode, url) => {
    // Le jeton est authentique (vrai secret) mais son rôle est réécrit. Le
    // serveur lit le rôle EN BASE à chaque requête : le jeton n'en décide pas.
    const falsifie = jeton(COMPTES.client, { role: 'Admin', organisationId: null });
    expect((await appel(methode, url, falsifie)).status).toBe(403);
  });
});

describe('jetons invalides, périmés ou détournés', () => {
  const URL = '/api/v1/admin/utilisateurs';

  it('signé avec un autre secret : 401', async () => {
    expect((await appel('get', URL, jeton(COMPTES.admin, {}, 'secret-de-l-attaquant'))).status).toBe(401);
  });

  it('algorithme « none » (non signé) : 401', async () => {
    const nonSigne = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: COMPTES.admin.id, role: 'Admin', tv: 5 })}.`;
    expect((await appel('get', URL, nonSigne)).status).toBe(401);
  });

  it('expiré : 401', async () => {
    const expire = jeton(COMPTES.admin, { exp: Math.floor(Date.now() / 1000) - 60 }, jwtConfig.secret, {});
    expect((await appel('get', URL, expire)).status).toBe(401);
  });

  it('jeton de challenge MFA présenté comme jeton d’accès : 401', async () => {
    const mfa = jwt.sign({ id: COMPTES.admin.id, type: 'mfa' }, jwtConfig.secret, { expiresIn: '5m' });
    expect((await appel('get', URL, mfa)).status).toBe(401);
  });

  it('refresh token présenté comme jeton d’accès : 401', async () => {
    const refresh = jwt.sign({ id: COMPTES.admin.id, type: 'refresh' }, jwtConfig.refreshSecret, { expiresIn: '7d' });
    expect((await appel('get', URL, refresh)).status).toBe(401);
  });

  it('révoqué (mot de passe changé depuis : token_version a bougé) : 401', async () => {
    // Le compte admin est en version 5 ; ce jeton a été signé en version 4.
    expect((await appel('get', URL, jeton(COMPTES.admin, { tv: 4 }))).status).toBe(401);
  });

  it('compte supprimé depuis l’émission du jeton : 401', async () => {
    const fantome = { ...COMPTES.admin, id: 'u-supprime' };
    expect((await appel('get', URL, jeton(fantome))).status).toBe(401);
  });

  it('en-tête sans le préfixe Bearer : 401', async () => {
    const r = await request(app).get(URL).set('Authorization', jeton(COMPTES.admin));
    expect(r.status).toBe(401);
  });

  it.each(['inactif', 'attente', 'rejete'])('compte %s : 403', async (cle) => {
    expect((await appel('get', '/api/v1/organisation/membres', jeton(COMPTES[cle]))).status).toBe(403);
  });
});

describe('administration d’organisation — un simple membre (Client)', () => {
  it.each([
    ['put', '/api/v1/organisation'],
    ['get', '/api/v1/organisation/membres'],
    ['post', '/api/v1/organisation/membres'],
    ['put', `/api/v1/organisation/membres/${UUID}`],
    ['delete', `/api/v1/organisation/membres/${UUID}`],
    ['post', '/api/v1/organisation/membres/import'],
    ['post', '/api/v1/organisation/equipes'],
    ['delete', `/api/v1/organisation/equipes/${UUID}`],
    ['post', '/api/v1/organisation/filiales'],
  ])('%s %s : 403', async (methode, url) => {
    expect((await appel(methode, url, jeton(COMPTES.client))).status).toBe(403);
  });
});

describe('fichiers privés — le contrôle d’accès ne se contourne pas par la méthode HTTP', () => {
  const CONTENU = 'CONTENU-CONFIDENTIEL-ORGANISATION-B';

  beforeAll(() => {
    fs.mkdirSync(path.join(DOSSIER, 'plans', 'projet_b'), { recursive: true });
    fs.writeFileSync(path.join(DOSSIER, 'plans', 'projet_b', 'plan-secret.pdf'), `%PDF-1.7\n${CONTENU}`);
  });

  it.each([
    ['post', '/uploads/plans/projet_b/plan-secret.pdf'],
    ['put', '/uploads/plans/projet_b/plan-secret.pdf'],
    ['patch', '/uploads/plans/projet_b/plan-secret.pdf'],
    ['delete', '/uploads/plans/projet_b/plan-secret.pdf'],
    ['post', '/api/v1/uploads/plans/projet_b/plan-secret.pdf'],
  ])('%s %s ne livre pas le fichier', async (methode, url) => {
    // Avant correctif : `checkFileAccess` laissait passer toute méthode autre
    // que GET/HEAD SANS contrôle, et le relais servait le fichier quand même.
    const r = await appel(methode, url, jeton(COMPTES.client));

    expect(r.status).toBe(404);
    expect(r.text || '').not.toContain(CONTENU);
  });
});

describe('garde de rôle ajoutée — photos d’inspection', () => {
  it('un client ne dépose pas de preuve sur une inspection : 403', async () => {
    const r = await appel('post', `/api/v1/inspections/${UUID}/photos`, jeton(COMPTES.client));
    expect(r.status).toBe(403);
  });
});
