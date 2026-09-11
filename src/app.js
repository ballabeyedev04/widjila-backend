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
const crypto = require('node:crypto');
const redisClient = require('./config/redis.js');
const requestId = require('./middlewares/requestId.middleware.js');
const metrics = require('./utils/metrics.js');
const etatApplication = require('./utils/etatApplication.js');
const { avecDelai } = require('./utils/circuitBreaker.js');

// Créer le dossier des uploads au démarrage (si absent)
ensureUploadDir();

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Nginx tourne sur le même serveur → 1 seul proxy de confiance (loopback)
// Nécessaire pour que express-rate-limit lise X-Forwarded-For correctement
app.set('trust proxy', 1);

// ── Corrélation et mesure — EN PREMIER ─────────────────────────────────────
// Toute réponse, y compris un refus de CORS ou de limiteur, porte ainsi un
// `X-Request-Id` et entre dans les métriques (voir requestId.middleware.js
// et utils/metrics.js). Deux middlewares synchrones, sans accès réseau.
app.use(requestId);
app.use(metrics.mesurerRequetes);

// Sonde du pool PostgreSQL pour /metrics : connexions utilisées, libres, et
// requêtes en ATTENTE d'une connexion — le signal d'un pool épuisé.
metrics.enregistrerSonde('pool_db', () => {
  const pool = sequelize.connectionManager?.pool;
  if (!pool || typeof pool.size !== 'number') return null;
  return {
    taille: pool.size,
    disponibles: pool.available,
    utilisees: pool.using,
    enAttente: pool.waiting,
    max: pool.maxSize ?? null,
  };
});

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
// Formats `combined` / `dev` réécrits avec l'URL et le référent MASQUÉS : le
// lien de partage d'un rapport (/r/:token) et certains jetons passés en
// paramètre sont des secrets, que les journaux conservaient en clair (audit
// sécurité — voir utils/masquerUrl.js).
const masquerUrl = require('./utils/masquerUrl.js');
morgan.token('url-masquee', (req) => masquerUrl(req.originalUrl || req.url));
morgan.token('referent-masque', (req) => masquerUrl(req.headers.referer || req.headers.referrer || ''));
// Identifiant de requête et utilisateur : sans eux, la ligne d'accès ne se
// reliait ni à la ligne d'erreur du même appel, ni à la personne concernée.
// L'utilisateur est lu à la FIN de la requête (morgan écrit à la réponse),
// donc après `auth`. Identifiant interne (UUID), jamais l'e-mail.
morgan.token('request-id', (req) => req.id || '-');
morgan.token('utilisateur', (req) => req.user?.id || '-');
// `:response-time` manquait au format de production : impossible de
// retrouver les appels lents dans les journaux.
const FORMAT_JOURNAL = isProd
  ? ':remote-addr - :utilisateur [:date[clf]] ":method :url-masquee HTTP/:http-version" :status :res[content-length] :response-time ms ":referent-masque" ":user-agent" rid=:request-id'
  : ':method :url-masquee :status :response-time ms - :res[content-length] rid=:request-id';
app.use(morgan(FORMAT_JOURNAL, {
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
  // Lecture SEULEMENT — CORRECTIF (audit sécurité, contournement du contrôle
  // d'accès). `checkFileAccess` laisse filer les méthodes autres que
  // GET/HEAD sans rien vérifier (il les croyait destinées au 404), mais ce
  // relais servait le fichier QUELLE QUE SOIT la méthode : un simple
  // `POST /uploads/…` livrait n'importe quel fichier de n'importe quelle
  // organisation à tout compte actif.
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
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

// ── Sondes de santé (hors versioning — Docker, load balancer, mobile) ─────
//
// DEUX questions distinctes, qu'une seule route mélangeait :
//
//   GET /health/live   — le process répond-il ? Aucune dépendance consultée :
//                        c'est la sonde de redémarrage. Une base en panne ne
//                        doit PAS faire redémarrer en boucle des workers sains.
//
//   GET /health/ready  — l'instance peut-elle servir ? Base, Redis, stockage.
//   GET /health          (alias, conservé : Dockerfile, deploy.yml, nginx et le
//                        détecteur de connexion du mobile l'appellent)
//                        503 si la base est injoignable OU si l'arrêt propre
//                        a commencé — le répartiteur retire l'instance avant
//                        que son port se ferme.
//
// Correctifs sur la sonde de disponibilité :
//   - la base n'avait AUCUN délai : pool épuisé, `authenticate()` attendait
//     l'acquisition d'une connexion (30 s) — bien au-delà des 10 s du
//     HEALTHCHECK Docker, qui concluait à un conteneur mort ;
//   - un stockage R2 qui ne répondait pas dans les 3 s était compté comme
//     SAIN (le délai rendait `joignable: null`, pris pour « pas en panne ») ;
//   - chaque appel refaisait une requête SQL et un appel R2. Le mobile
//     interroge cette route toutes les 20 s quand il se croit hors ligne :
//     pendant une panne, des milliers d'appareils la martelaient. Le bilan
//     est désormais mis en cache 5 s, et un seul calcul court à la fois.
const DELAI_SONDE_MS = 3000;
const DUREE_CACHE_SANTE_MS = 5000;
let bilanSante = null;
let bilanSanteLe = 0;
let bilanSanteEnCours = null;

async function evaluerSante() {
  const [dbCheck, storageCheck] = await Promise.allSettled([
    avecDelai(sequelize.authenticate(), DELAI_SONDE_MS, 'de base de données'),
    avecDelai(r2.ping(), DELAI_SONDE_MS, 'de stockage'),
  ]);

  const dbOk = dbCheck.status === 'fulfilled';
  const storage = storageCheck.status === 'fulfilled'
    ? storageCheck.value
    : { configure: null, joignable: false, delai_depasse: true };
  // R2 non configuré (repli disque local, cf. storage.service.js) n'est pas
  // une panne en développement — seule une config présente mais injoignable
  // dégrade le statut global.
  const storageOk = storage.joignable !== false;
  // Redis est un accélérateur (limiteurs, cache) : son absence dégrade, elle
  // ne rend pas l'instance inapte.
  const redis = redisClient ? (redisClient.status === 'ready' ? 'connected' : `disconnected (${redisClient.status})`) : 'non configuré';
  const redisOk = !redisClient || redisClient.status === 'ready';

  return {
    dbOk,
    corps: {
      status: dbOk && storageOk && redisOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'disconnected',
      storage: storage.configure === false ? 'disque local (R2 non configuré)' : (storage.joignable ? 'connected' : 'disconnected'),
      redis,
      uptime: process.uptime(),
      timestamp: Date.now(),
    },
  };
}

function santeEnCache() {
  if (bilanSante && Date.now() - bilanSanteLe < DUREE_CACHE_SANTE_MS) return Promise.resolve(bilanSante);
  if (!bilanSanteEnCours) {
    bilanSanteEnCours = evaluerSante()
      .then((bilan) => {
        bilanSante = bilan;
        bilanSanteLe = Date.now();
        return bilan;
      })
      .finally(() => { bilanSanteEnCours = null; });
  }
  return bilanSanteEnCours;
}

app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

const sondeDisponibilite = async (req, res) => {
  const { dbOk, corps } = await santeEnCache();
  const enArret = etatApplication.estEnArret();
  const reponse = enArret ? { ...corps, status: 'arret en cours' } : corps;
  res.setHeader('Cache-Control', 'no-store');
  res.status(dbOk && !enArret ? 200 : 503).json(reponse);
};
app.get('/health', sondeDisponibilite);
app.get('/health/ready', sondeDisponibilite);

// ── Métriques (voir utils/metrics.js) ──────────────────────────────────────
// En production, uniquement avec `Authorization: Bearer <METRICS_TOKEN>` ;
// sans jeton configuré, la route n'existe pas. Elle révèle les routes, les
// volumes et les pannes des dépendances : rien à exposer publiquement.
app.get('/metrics', (req, res) => {
  const jeton = process.env.METRICS_TOKEN;
  if (!jeton && isProd) {
    return res.status(404).json({ success: false, message: 'Ressource introuvable', requestId: req.id });
  }
  if (jeton) {
    const fourni = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const attendu = Buffer.from(jeton);
    if (fourni.length !== attendu.length || !crypto.timingSafeEqual(fourni, attendu)) {
      return res.status(401).json({
        success: false,
        message: 'Non authentifié',
        error: { code: 'NON_AUTHENTIFIE', message: 'Non authentifié' },
        requestId: req.id,
      });
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.format === 'prometheus') {
    return res.type('text/plain; version=0.0.4').send(metrics.formatPrometheus());
  }
  return res.json(metrics.instantane());
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
// Module Rapports du cahier des charges (§ 9) — /api/v1/reports/…
const reportsRoutes      = require('./modules/rapport/route/reports.route.js');
const dashboardRoutes    = require('./modules/dashboard/route/dashboard.route.js');
const corpsEtatRoutes    = require('./modules/corpsEtat/route/corpsEtat.route.js');
const referentielRoutes  = require('./modules/referentiel/route/referentiel.route.js');
const { referentiels }   = require('./modules/referentiel/typesReferentiels.js');
const phaseRoutes        = require('./modules/phase/route/phaseReferentiel.route.js');

const adminUtilisateurRoutes = require('./modules/admin/route/gestionUtilisateur.route.js');
const adminOrganisationRoutes = require('./modules/admin/route/gestionOrganisation.route.js');
const adminStatistiquesRoutes = require('./modules/admin/route/statistiques.route.js');
const adminAuditLogRoutes     = require('./modules/admin/route/auditLog.route.js');
const adminDemandeRoutes      = require('./modules/admin/route/demandeInscription.route.js');
const adminPlansAbonnementRoutes = require('./modules/subscription/route/planAbonnement.route.js');
const adminAbonnementsRoutes     = require('./modules/subscription/route/abonnementAdmin.route.js');
const suppressionCompteRoutes = require('./modules/suppressionCompte/route/suppressionCompte.route.js');
const adminSuppressionRoutes  = require('./modules/suppressionCompte/route/adminSuppressionCompte.route.js');
const subscriptionRoutes = require('./modules/subscription/route/subscription.route.js');
const paytechRoutes = require('./modules/paytech/route/paytech.route.js');
const supportRoutes = require('./modules/support/route/support.route.js');

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

// Dépôt PUBLIC d'une demande de suppression de compte (exigence Google Play).
// Monté ICI, avant `checkSubscription` : le demandeur n'est pas authentifié et
// n'appartient à aucune organisation — un contrôle d'abonnement le rejetterait.
app.use('/api/v1/suppression-compte', suppressionCompteRoutes);

// Les routes chantiers sont montées en premier : les sous-ressources
// (plans, réserves, inspections, documents, rapports) passent ensuite
// car elles partagent le préfixe /chantiers/:id/...
app.use('/api/v1/chantiers', chantierRoutes);
app.use('/api/v1', planRoutes);
app.use('/api/v1', reserveRoutes);
app.use('/api/v1', inspectionRoutes);
app.use('/api/v1', documentRoutes);
app.use('/api/v1', rapportRoutes);
app.use('/api/v1', reportsRoutes);

// Synchronisation hors ligne INCRÉMENTALE du mobile (audit synchronisation) :
// changements et suppressions de réserves depuis un curseur. Lecture seule,
// aucune dépendance aux routes ci-dessus.
const syncRoutes = require('./modules/sync/route/sync.route.js');
app.use('/api/v1', syncRoutes);

// Lien de partage d'un rapport, sous sa forme COURTE — cahier des charges
// Rapports § 14 : « widjila.app/r/{token_securise} ». La forme longue
// (/api/v1/r/:token) est servie par le routeur ci-dessus ; celle-ci existe
// pour le jour où le domaine principal pointe sur l'API.
app.get('/r/:token', ...reportsRoutes.lienPublic);

app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1', partenaireRoutes);
// Énumérations métier (statuts, sévérités, types) — source unique lue par le
// web et le mobile, qui les recopiaient. Lecture seule : ce sont des colonnes
// ENUM, pas des données administrables.
app.use('/api/v1/referentiels',  referentielRoutes);
// Référentiels de TYPE administrables : /types-document, /types-intervenant,
// /types-inspection. Ils remplacent trois colonnes ENUM que le client ne
// pouvait pas étendre sans migration.
for (const { chemin, routeur } of referentiels) {
  app.use(`/api/v1${chemin}`, routeur);
}
// Catalogue des corps d'état (métiers BTP) — référentiel administrable.
app.use('/api/v1/corps-etat',    corpsEtatRoutes);
// Référentiel des phases — distinct de /chantiers/:id/phases (planning).
app.use('/api/v1/phases',        phaseRoutes);
app.use('/api/v1/dashboard',     dashboardRoutes);

// ── Abonnement (accessible même sans abonnement pour /plans et /webhook) ──────
app.use('/api/v1/abonnement',    subscriptionRoutes);

// ── Contact du support (accessible même sans abonnement) ──────────────────────
app.use('/api/v1/support',       supportRoutes);

// ── Filet de sécurité — PAS la garde principale ──────────────────────────────
//
// ⚠️ Ne pas s'y fier en ajoutant une route. Express exécute les `app.use` dans
// l'ordre d'enregistrement : toutes les routes montées CI-DESSUS répondent
// avant d'arriver ici, ce middleware ne les voit jamais. Il ne s'applique
// qu'à ce qui serait monté plus bas.
//
// La vraie garde d'abonnement est posée ROUTE PAR ROUTE (`checkSubscription`
// dans chaque fichier de routes métier), et les restrictions par formule le
// sont par `requireFonctionnalite` / `verifierLimite`. Une nouvelle route
// métier doit donc déclarer `checkSubscription` explicitement : rien ici ne
// le fera à sa place.
app.use('/api/v1', (req, res, next) => {
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
// Catalogue des formules (« Prix abonnements ») et suivi des abonnements
// clients. Sous /admin/ : le super-admin plateforme n'a pas d'organisation,
// donc pas d'abonnement à vérifier.
app.use('/api/v1/admin/plans-abonnement', adminPlansAbonnementRoutes);
app.use('/api/v1/admin/abonnements',      adminAbonnementsRoutes);
app.use('/api/v1/admin/demandes-inscription', adminDemandeRoutes);
app.use('/api/v1/admin/demandes-suppression', adminSuppressionRoutes);

// ── 404 — route inconnue ───────────────────────────────────────────────────
// Même enveloppe que le gestionnaire d'erreurs : `error.code` distingue une
// ROUTE inconnue (faute du client) d'une ressource absente (404 métier).
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ressource introuvable',
    error: { code: 'ROUTE_INTROUVABLE', message: 'Ressource introuvable' },
    requestId: req.id,
  });
});

// ── Gestionnaire d'erreurs centralisé (doit être en dernier) ──────────────
app.use(errorHandler);

module.exports = app;
