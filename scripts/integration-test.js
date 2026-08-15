'use strict';
/**
 * Test d'intégration — vérification des correctifs de sécurité (audit).
 * Prérequis : PostgreSQL local démarré (port 5433, user chantieruser/test123,
 *             DB suivie_chantier) — voir deploy/test-postgres.sh.
 * Usage     : node scripts/integration-test.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { generateSecret, generateSync } = require('otplib');

const BASE = 'http://127.0.0.1:3109';
const PORT = 3109;

let nbPass = 0;
let nbFail = 0;

function ok(label, cond, detail) {
  if (cond) { nbPass++; console.log(`  ✅ ${label}`); }
  else { nbFail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

/** Petit client HTTP avec gestion des cookies (jar). */
function makeClient() {
  const jar = {};
  const req = (method, p, body, headers = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers, ...(data ? { 'Content-Type': 'application/json' } : {}) };
    // Un header Cookie explicite prime sur le jar (permet de rejouer un token
    // MFA capturé même si le serveur a vidé le cookie côté jar).
    if (!headers.Cookie) {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
    }
    const r = http.request(BASE + p, { method, headers: h }, (res) => {
      // Enregistrer les cookies Set-Cookie (les httpOnly ne seront pas envoyés
      // par un vrai navigateur mais ici on les lit pour les tests MFA).
      const sc = res.headers['set-cookie'];
      if (sc) sc.forEach((c) => {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar[pair.slice(0, idx)] = pair.slice(idx + 1);
      });
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.end(data);
  });
  return { req, jar };
}

const EMAIL_A = 'alice@test.com';
const EMAIL_B = 'bob@test.com';

async function main() {
  // ── Boot du serveur (vraie app, vraie DB jetable) ──────────────────────
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PORT: '5433',
      DB_PASSWORD: 'test123',
      NODE_ENV: 'development',
      // Desserrer le rate-limit global auth pour isoler le compteur de
      // tentatives MFA (H3) : le test enchaîne volontairement 6 mauvais codes.
      AUTH_RATE_LIMIT_MAX: '1000',
      AUTH_RATE_LIMIT_WINDOW_MIN: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`  [srv-err] ${d}`));

  // Attendre que /health réponde
  const health = () => new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (x) => {
      x.resume(); res(true);
    });
    r.on('error', () => res(false));
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { up = await health(); if (!up) await new Promise((r) => setTimeout(r, 500)); }
  ok('Serveur démarré (/health répond)', up);
  if (!up) { server.kill(); process.exit(1); }

  const a = makeClient();
  const b = makeClient();

  // ── Reset DB (idempotence) : purge des utilisateurs/challenges ────────
  const { Pool } = require('pg');
  const poolReset = new Pool({ host: '127.0.0.1', port: 5433, user: 'postgres', password: undefined, database: 'suivie_chantier' });
  await poolReset.query('DELETE FROM refresh_tokens');
  await poolReset.query('DELETE FROM mfa_challenge');
  await poolReset.query('DELETE FROM connexion_logs');
  await poolReset.query('DELETE FROM utilisateur WHERE email IN ($1, $2)', [EMAIL_A, EMAIL_B]);
  await poolReset.end();

  // ── 1. Inscription (créé l'org A, userA Admin) ─────────────────────────
  console.log('\n— Inscription & login');
  let r = await a.req('POST', '/api/v1/auth/register', {
    nom: 'Dupont', prenom: 'Alice', email: EMAIL_A, mot_de_passe: 'MotDePasseFort123!',
    telephone: '+221771234567', organisationNom: 'Entreprise A',
  });
  ok('Register A (201/200)', r.status === 200 || r.status === 201, r.raw);

  r = await a.req('POST', '/api/v1/auth/login', { identifiant: EMAIL_A, mot_de_passe: 'MotDePasseFort123!' });
  ok('Login A → accessToken', !!r.body?.data?.token, r.raw);
  ok('Login A → refreshToken ABSENT du body (M1)', !r.body?.data?.refreshToken, r.raw);
  const tokenA = r.body?.data?.token;
  const authA = { Authorization: `Bearer ${tokenA}` };

  // ── 2. C2/M2 : aucune fuite mfa_secret dans les réponses ───────────────
  console.log('\n— Fuite mfa_secret (C2/M2)');
  r = await a.req('GET', '/api/v1/organisation/membres', null, authA);
  ok('GET /organisation/membres → 200', r.status === 200, r.raw);
  const membresRaw = r.raw;
  ok('C2: aucun mfa_secret dans la liste des membres', !membresRaw.includes('mfa_secret'), 'le champ mfa_secret est présent');
  ok('C2: aucun mfa_token/challenge exposé', !membresRaw.includes('mfa_challenge') && !membresRaw.includes('tokenHash'), '');
  const membres = r.body?.data?.membres || [];
  ok('La liste contient Alice', membres.some((m) => m.email === EMAIL_A), r.raw);

  r = await a.req('GET', '/api/v1/account/me', null, authA);
  ok('GET /account/me → 200', r.status === 200, r.raw);
  ok('M2: /account/me sans mfa_secret', !r.raw.includes('mfa_secret'), r.raw.slice(0, 200));

  // ── 3. MFA : provision → enable (code correct) ─────────────────────────
  console.log('\n— MFA provision/activation');
  r = await a.req('POST', '/api/v1/account/mfa/provision', null, authA);
  ok('Provision MFA → 200 avec secret', r.status === 200 && !!r.body?.data?.secret, r.raw);
  const mfaSecret = r.body?.data?.secret;
  const code = generateSync({ secret: mfaSecret });
  r = await a.req('POST', '/api/v1/account/mfa/enable', { code, secret: mfaSecret }, authA);
  ok('Activation MFA avec code correct → succès', r.status === 200 && r.body?.success === true, r.raw);

  // M3 : vérifier que mfa_secret est CHIFFRÉ au repos
  const pool = new Pool({ host: '127.0.0.1', port: 5433, user: 'postgres', password: undefined, database: 'suivie_chantier' });
  const { rows } = await pool.query('SELECT mfa_secret, mfa_active FROM utilisateur WHERE email = $1', [EMAIL_A]);
  ok('M3: mfa_secret chiffré au repos (v1:<iv>:<tag>)', /^v1:/.test(rows[0]?.mfa_secret || ''), `valeur: ${(rows[0]?.mfa_secret || '').slice(0, 20)}`);
  ok('M3: mfa_active=true', rows[0]?.mfa_active === true);
  await pool.end();

  // ── 4. Login → MFA requis → mfaToken en cookie (M1), pas dans le body ──
  console.log('\n— Challenge MFA au login');
  r = await a.req('POST', '/api/v1/auth/login', { identifiant: EMAIL_A, mot_de_passe: 'MotDePasseFort123!' });
  ok('Login A (MFA actif) → mfa requis', r.status === 200 && r.body?.data?.mfaRequise === true, r.raw);
  ok('M1: mfaToken dans Set-Cookie httpOnly', !!a.jar.mfaToken, 'cookie mfaToken absent');
  ok('M1: mfaToken ABSENT du body', !r.body?.mfaToken, r.raw);
  const sc = r.headers['set-cookie']?.find((c) => c.startsWith('mfaToken=')) || '';
  ok('M1: cookie mfaToken httpOnly', sc.toLowerCase().includes('httponly'), sc);
  ok('M1: cookie mfaToken sameSite strict', sc.toLowerCase().includes('samesite'), sc);

  // ── 5. H3 : tentative brute force TOTP limitée ──────────────────────────
  // NB : le contrôleur vide le cookie mfaToken à chaque échec → on capture le
  // jeton UNE SEULE fois (l'attaque rejoue le même jeton volé).
  console.log('\n— Anti brute-force TOTP (H3)');
  const tokBF = a.jar.mfaToken;
  let lastStatus;
  for (let i = 0; i < 6; i++) {
    r = await a.req('POST', '/api/v1/auth/mfa-verify', { code: '000000' }, { Cookie: `mfaToken=${tokBF}` });
    lastStatus = r;
  }
  ok('H3: 6 mauvais codes → le challenge est révoqué (400/401)', lastStatus.status === 400 || lastStatus.status === 401, `${lastStatus.status} ${lastStatus.raw}`);
  ok('H3: message compte verrouillé/échec', /[Tt]rop de tentatives|échou|invalide|verrouill|expir/i.test(lastStatus.raw || ''), lastStatus.raw);

  // ── 6. H3 : single-use du token MFA + succès avec bon code ─────────────
  console.log('\n— Single-use du challenge MFA (H3)');
  r = await a.req('POST', '/api/v1/auth/login', { identifiant: EMAIL_A, mot_de_passe: 'MotDePasseFort123!' });
  const bonCode = generateSync({ secret: mfaSecret });
  r = await a.req('POST', '/api/v1/auth/mfa-verify', { code: bonCode }, { Cookie: `mfaToken=${a.jar.mfaToken}` });
  ok('H3: bon code → accès accordé', r.status === 200 && !!r.body?.data?.token, r.raw);
  ok('H3: refreshToken ABSENT du body (M1)', !r.body?.data?.refreshToken, '');
  const tokenA2 = r.body?.data?.token;

  // Rejouer le même challenge (token déjà consommé)
  r = await a.req('POST', '/api/v1/auth/login', { identifiant: EMAIL_A, mot_de_passe: 'MotDePasseFort123!' });
  const codeReplay = generateSync({ secret: mfaSecret });
  const tok1 = a.jar.mfaToken;
  const first = await a.req('POST', '/api/v1/auth/mfa-verify', { code: codeReplay }, { Cookie: `mfaToken=${tok1}` });
  const second = await a.req('POST', '/api/v1/auth/mfa-verify', { code: codeReplay }, { Cookie: `mfaToken=${tok1}` });
  ok('H3: le même challenge ne peut PAS être rejoué', first.status === 200 && (second.status === 400 || second.status === 401), `1er=${first.status} 2e=${second.status}`);

  // ── 7. H1 : /uploads exige une authentification ─────────────────────────
  console.log('\n— /uploads authentifié (H1)');
  r = await a.req('GET', '/uploads/fichier_inexistant.png', null);
  ok('H1: /uploads sans token → refusé (401/403)', r.status === 401 || r.status === 403, `status=${r.status}`);
  r = await a.req('GET', '/uploads/fichier_inexistant.png', null, authA);
  ok('H1: /uploads avec token → 404 (fichier absent, pas 401)', r.status === 404, `status=${r.status}`);

  // ── 8. C1 : ChefProjet ne peut PAS s'auto-promouvoir Admin ─────────────
  console.log('\n— Escalade de privilèges (C1)');
  r = await a.req('POST', '/api/v1/organisation/membres', { nom: 'Martin', prenom: 'Bob', email: EMAIL_B, role: 'ChefProjet', mot_de_passe: 'TempPass123!' }, authA);
  ok('Création membre Bob (ChefProjet)', r.status === 200 || r.status === 201, r.raw);
  const bobId = r.body?.data?.utilisateur?.id;
  ok('ID Bob obtenu', !!bobId, r.raw);

  r = await b.req('POST', '/api/v1/auth/login', { identifiant: EMAIL_B, mot_de_passe: 'TempPass123!' });
  const tokenB = r.body?.data?.token;
  ok('Login Bob → token', !!tokenB, r.raw);
  const authB = { Authorization: `Bearer ${tokenB}` };

  // Bob (ChefProjet) tente de se promouvoir Admin
  r = await b.req('PUT', `/api/v1/organisation/membres/${bobId}`, { role: 'Admin' }, authB);
  ok('C1: ChefProjet → Admin REFUSÉ', r.status === 400 || r.status === 403, `${r.status} ${r.raw}`);
  ok('C1: message explicite', /[Aàa]utoris|[Rr]efus|[Rr]ôle|[rR]ôle/.test(r.raw || ''), r.raw);

  // Bob tente d'assigner Admin à un AUTRE membre → refusé aussi (le rôle Admin
  // n'est jamais assignable via l'organisation, même par un gestionnaire)
  const aliceMembre = membres.find((m) => m.email === EMAIL_A);
  if (aliceMembre?.id) {
    r = await b.req('PUT', `/api/v1/organisation/membres/${aliceMembre.id}`, { role: 'Admin' }, authB);
    ok('C1: personne ne peut assigner Admin (même à un autre)', r.status === 400 || r.status === 403, `${r.status} ${r.raw}`);
  }

  // ── 9. C2 : la liste des membres vue par Bob ne fuit pas mfa_secret ─────
  r = await b.req('GET', '/api/v1/organisation/membres', null, authB);
  ok('Bob (ChefProjet) peut lister', r.status === 200, `${r.status}`);
  ok('C2: liste vue par ChefProjet sans mfa_secret', !r.raw.includes('mfa_secret'), '');

  // ── 10. Rôle hors liste rejeté (renforcement C1) ────────────────────────
  r = await a.req('PUT', `/api/v1/organisation/membres/${bobId}`, { role: 'SuperAdmin' }, authA);
  ok('C1: rôle inventé "SuperAdmin" REFUSÉ', r.status === 400 || r.status === 403 || r.status === 422, `${r.status} ${r.raw}`);

  server.kill();
  console.log(`\n═══════════════════════════════════════`);
  console.log(`RÉSULTATS : ${nbPass} ✅  /  ${nbFail} ❌`);
  console.log(`═══════════════════════════════════════`);
  process.exit(nbFail ? 1 : 0);
}

main().catch((e) => { console.error('ERREUR fatale du test :', e); process.exit(1); });
