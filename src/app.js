'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { corsConfig, rateLimitConfig } = require('./config/security.js');
const logger = require('./utils/logger.js');
const sequelize = require('./config/db.js');
const errorHandler = require('./middlewares/errorHandler.middleware.js');
const auth = require('./middlewares/auth.middleware.js');
const checkActiveUser = require('./middlewares/checkActiveUser.middleware.js');
const checkFileAccess = require('./middlewares/checkFileAccess.middleware.js');
const checkSubscription = require('./middlewares/checkSubscription.middleware.js');
const auditTrail = require('./middlewares/auditTrail.middleware.js');
// `captureRawBody` doit être passé à express.json() ci-dessous — voir le
// commentaire à cet endroit. Ce require n'est PAS mort : ne pas le supprimer.
const { captureRawBody } = require('./middlewares/rawBody.middleware.js');
const { ensureUploadDir, ouvrirFichier } = require('./infrastructure/storage.service.js');
const r2 = require('./infrastructure/r2.service.js');

// Créer le dossier des uploads au démarrage (si absent)
ensureUploadDir();

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Nginx tourne sur le même serveur → 1 seul proxy de confiance (loopback)
// Nécessaire pour que express-rate-limit lise X-Forwarded-For correctement
app.set('trust proxy', 1);

// ── Sécurité & headers ─────────────────────────────────────────────────────
// helmet avec directives explicites (audit M10) : CSP stricte, Permissions-Policy
// restreinte, Referrer-Policy. Le CSP s'applique aux réponses de l'API (JSON) ;
// l'API ne sert aucun HTML dynamique.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
// Permissions-Policy : helmet v8 ne l'émet plus → posé manuellement (audit M10).
// Miroir de la directive posée côté nginx (proxy 443).
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), fullscreen=()");
  next();
});
app.use(cors(corsConfig));
app.use(cookieParser());

// ── Logging des requêtes entrantes ─────────────────────────────────────────
app.use(morgan(isProd ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ── Body parsing ───────────────────────────────────────────────────────────
// `verify` reçoit les octets BRUTS avant le parsing JSON : c'est le seul
// endroit où ils existent encore. La vérification de signature des webhooks
// Stripe porte sur ces octets exacts — une fois le flux consommé ici, aucun
// middleware en aval ne peut les récupérer, et re-sérialiser `req.body`
// produit des octets différents (espaces, ordre des clés, échappements
// unicode) donc une signature systématiquement invalide.
// Le hook ne conserve le Buffer que pour les requêtes de webhook.
app.use(express.json({ limit: '512kb', verify: captureRawBody }));
// extended:false → parseur querystring simple (pas de prototype pollution, audit L7)
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

// ── Rate limiting global (1000 req / 15 min) ───────────────────────────────
app.use(rateLimit(rateLimitConfig));

// ── Fichiers uploadés (profils, plans, documents, pièces…) ─────────────────
// AUTHENTIFICATION OBLIGATOIRE (audit H1) : les fichiers ne sont plus servis
// publiquement. Le client doit joindre son Bearer token (Authorization) sur
// les requêtes vers /uploads/* — le front doit donc charger ces fichiers via
// fetch/axios (blob) plutôt qu'en <img src> direct.
// Les URL stockées en base sont de la forme "/uploads/plans/xxx.pdf". Le client
// admin ayant pour baseURL "/api/v1", ses requêtes arrivent préfixées — d'où un
// double montage. Sans le second, tous les fichiers répondaient 404 et aucun
// plan ni document n'était jamais visible dans l'interface.
// `auth + checkActiveUser` ne vérifiaient QUE « authentifié et actif » : aucun
// contrôle d'appartenance. Tout compte actif, toutes organisations confondues,
// téléchargeait n'importe quel PV signé, plan ou DOE en connaissant le chemin,
// sans aucune journalisation. `checkFileAccess` retrouve la ressource
// propriétaire en base et confine l'accès à l'organisation de l'appelant.
// Il DOIT rester avant express.static.
/**
 * Sert un fichier PRIVÉ après contrôle des droits.
 *
 * Le contenu vit sur Cloudflare R2 (bucket privé) — jamais en base, et plus sur
 * le disque du serveur. On le relaie ici plutôt que de rediriger vers une URL
 * signée : le flux reste sur la même origine (aucune configuration CORS sur le
 * bucket), et l'autorisation ne peut pas être contournée en conservant un lien.
 *
 * `ouvrirFichier` tente R2 puis le disque local, de sorte que les fichiers
 * déposés avant la bascule restent lisibles sans migration de données.
 */
const relayerFichier = async (req, res, next) => {
  try {
    const contenu = await ouvrirFichier(decodeURIComponent(req.path));
    if (!contenu) return next(); // → 404 du gestionnaire final

    res.setHeader('Content-Type', contenu.contentType);
    if (contenu.taille) res.setHeader('Content-Length', contenu.taille);
    // Un fichier privé ne doit jamais être mis en cache par un intermédiaire.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    contenu.stream.on('error', next);
    contenu.stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

const servirUploads = [auth, checkActiveUser, checkFileAccess, relayerFichier];
app.use('/uploads', ...servirUploads);
app.use('/api/v1/uploads', ...servirUploads);

// ── Health check (hors versioning — utilisé par Docker / load balancer) ───
// Correctif (audit — Charge à 10 000 utilisateurs §4) : ne vérifiait QUE la
// base de données. Derrière un load-balancer multi-instances, une panne du
// stockage R2 (tous les plans/documents/photos) restait invisible de la
// supervision — l'instance continuait de recevoir du trafic alors qu'une
// part significative de l'application était dégradée.
//
// La sonde R2 est bornée à 3s (Promise.race) pour ne jamais faire dépendre
// la latence du health check d'un fournisseur externe lent à répondre.
app.get('/health', async (req, res) => {
  const [dbCheck, storageCheck] = await Promise.allSettled([
    sequelize.authenticate().then(() => 'connected'),
    Promise.race([
      r2.ping(),
      new Promise((resolve) => setTimeout(() => resolve({ configure: null, joignable: null, delai_depasse: true }), 3000)),
    ]),
  ]);

  const dbOk = dbCheck.status === 'fulfilled';
  const storage = storageCheck.status === 'fulfilled' ? storageCheck.value : { configure: null, joignable: false };
  // R2 non configuré (repli disque local, cf. storage.service.js) n'est pas
  // une panne en développement — seule une config présente mais injoignable
  // dégrade le statut global.
  const storageOk = storage.joignable !== false;

  const body = {
    status: dbOk && storageOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'disconnected',
    storage: storage.configure === false ? 'disque local (R2 non configuré)' : (storage.joignable ? 'connected' : 'disconnected'),
    uptime: process.uptime(),
    timestamp: Date.now(),
  };
  res.status(dbOk ? 200 : 503).json(body);
});

// ── Routes ─────────────────────────────────────────────────────────────────
// Pattern : route → controller → service → model. Chaque module de routes
// est monté sous le préfixe versionné /api/v1.
const authRoutes         = require('./modules/auth/route/auth.route.js');
const accountRoutes      = require('./modules/account/route/account.route.js');
const organisationRoutes = require('./modules/organisation/route/organisation.route.js');
const chantierRoutes     = require('./modules/chantier/route/chantier.route.js');
const planRoutes         = require('./modules/plan/route/plan.route.js');
const reserveRoutes      = require('./modules/reserve/route/reserve.route.js');
const inspectionRoutes   = require('./modules/inspection/route/inspection.route.js');
const documentRoutes     = require('./modules/document/route/document.route.js');
const notificationRoutes = require('./modules/notification/route/notification.route.js');
const partenaireRoutes   = require('./modules/organisation/route/partenaire.route.js');
const rapportRoutes      = require('./modules/rapport/route/rapport.route.js');
const dashboardRoutes    = require('./modules/dashboard/route/dashboard.route.js');

const adminUtilisateurRoutes = require('./modules/admin/route/gestionUtilisateur.route.js');
const adminOrganisationRoutes = require('./modules/admin/route/gestionOrganisation.route.js');
const adminStatistiquesRoutes = require('./modules/admin/route/statistiques.route.js');
const adminAuditLogRoutes     = require('./modules/admin/route/auditLog.route.js');
const subscriptionRoutes = require('./modules/subscription/route/subscription.route.js');
const paytechRoutes = require('./modules/paytech/route/paytech.route.js');

// Journal d'audit générique (audit — élargissement du périmètre) : montée
// une seule fois, avant toutes les routes mutantes de l'API — voir le
// commentaire d'en-tête de auditTrail.middleware.js pour la portée exacte
// (routes /admin/* et /auth/* exclues, déjà couvertes par leurs propres
// mécanismes de journalisation).
app.use('/api/v1', auditTrail);

app.use('/api/v1/auth',          authRoutes);
app.use('/api/v1/account',       accountRoutes);
app.use('/api/v1/organisation',  organisationRoutes);
app.use('/api/v1/paytech',       paytechRoutes);

// Les routes chantiers sont montées en premier : les sous-ressources
// (plans, réserves, inspections, documents, rapports) passent ensuite
// car elles partagent le préfixe /chantiers/:id/...
app.use('/api/v1/chantiers', chantierRoutes);
app.use('/api/v1', planRoutes);
app.use('/api/v1', reserveRoutes);
app.use('/api/v1', inspectionRoutes);
app.use('/api/v1', documentRoutes);
app.use('/api/v1', rapportRoutes);

app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1', partenaireRoutes);
app.use('/api/v1/dashboard',     dashboardRoutes);

// ── Abonnement (accessible même sans abonnement pour /plans et /webhook) ──────
app.use('/api/v1/abonnement',    subscriptionRoutes);

// ── Middleware checkSubscription sur toutes les routes protégées (sauf /auth et /abonnement) ──
// À placer APRÈS les routes publiques et AVANT les routes qui doivent être protégées
app.use('/api/v1', (req, res, next) => {
  // Routes exemptées : auth (login/register/refresh/mfa), abonnement (plans/webhook/status sans abonnement)
  const exemptPaths = ['/auth/', '/abonnement/plans', '/abonnement/webhook'];
  const isExempt = exemptPaths.some(p => req.path.startsWith(p));
  if (isExempt) return next();
  return checkSubscription(req, res, next);
});

// ── Super-admin plateforme ──────────────────────────────────────────────────
app.use('/api/v1/admin/utilisateurs',  adminUtilisateurRoutes);
app.use('/api/v1/admin/organisations', adminOrganisationRoutes);
app.use('/api/v1/admin/statistiques',  adminStatistiquesRoutes);
app.use('/api/v1/admin/audit-logs',    adminAuditLogRoutes);

// ── 404 — route inconnue ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Ressource introuvable' });
});

// ── Gestionnaire d'erreurs centralisé (doit être en dernier) ──────────────
app.use(errorHandler);

module.exports = app;
