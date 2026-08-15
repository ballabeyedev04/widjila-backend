require('dotenv').config();

const JWT_SECRET         = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_RESET_SECRET   = process.env.JWT_RESET_SECRET;
const isProd             = process.env.NODE_ENV === 'production';

// ── Validation secrets JWT ─────────────────────────────────────────────────
const missingSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_RESET_SECRET'].filter(k => !process.env[k]);
if (missingSecrets.length) {
  throw new Error(`Variables d'environnement manquantes : ${missingSecrets.join(', ')}`);
}
if (JWT_SECRET === JWT_REFRESH_SECRET || JWT_SECRET === JWT_RESET_SECRET || JWT_REFRESH_SECRET === JWT_RESET_SECRET) {
  throw new Error('JWT_SECRET, JWT_REFRESH_SECRET et JWT_RESET_SECRET doivent tous être différents.');
}

// ── Validation CORS en production ──────────────────────────────────────────
const _rawCorsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
if (isProd && _rawCorsOrigins.includes('*')) {
  throw new Error("CORS_ORIGIN=* est interdit en production. Définissez une ou plusieurs origines explicites (ex: https://votre-app.com).");
}

// ── Validation credentials Admin en production ─────────────────────────────
// Bloque les valeurs par défaut livrées dans .env.example (et les anciennes)
const ADMIN_EMAILS_PAR_DEFAUT = ['admin@signapp.com', 'admin@votre-domaine.com'];

/**
 * Politique de mot de passe du compte super-admin plateforme (audit —
 * Sécurité §3).
 *
 * CORRECTIF : la seule protection ici était une comparaison EXACTE contre
 * deux mots de passe connus (`Admin1234!`, `ChangeMe_MotDePasseForte123!`).
 * N'importe quel troisième mauvais mot de passe (`Motdepasse2024!`, un mot
 * de passe court, un mot du dictionnaire) passait sans broncher — alors que
 * ce compte traverse `checkOrganisation` sans aucun filtre : accès total à
 * toutes les organisations clientes. Une politique de complexité réelle
 * remplace la simple liste noire, qui reste posée en défense en profondeur
 * (coût nul, aucune raison de la retirer).
 *
 * Volontairement plus stricte que `validations/common.js#motDePasse`
 * (utilisateurs normaux, 8 caractères, sans caractère spécial requis) : ce
 * compte a le rayon d'explosion le plus large de la plateforme.
 */
const ADMIN_MDP_PAR_DEFAUT = ['Admin1234!', 'ChangeMe_MotDePasseForte123!'];
const ADMIN_MDP_LONGUEUR_MIN = 12;
const ADMIN_MDP_MOTIFS_FAIBLES = [
  'password', 'motdepasse', 'azerty', 'qwerty', '123456', 'admin', 'changeme',
  'bienvenue', 'welcome', 'letmein', 'chantier', 'suivi',
];

/**
 * Vérifie la robustesse d'ADMIN_PASSWORD. Retourne un message d'erreur (ou
 * null si conforme) — testable indépendamment du `throw` ci-dessous.
 */
function validerMotDePasseAdmin(motDePasse, email) {
  if (!motDePasse) return 'ADMIN_PASSWORD est requis en production.';
  if (ADMIN_MDP_PAR_DEFAUT.includes(motDePasse)) {
    return "ADMIN_PASSWORD est la valeur par défaut. Changez-la avant le déploiement en production.";
  }
  if (motDePasse.length < ADMIN_MDP_LONGUEUR_MIN) {
    return `ADMIN_PASSWORD doit contenir au moins ${ADMIN_MDP_LONGUEUR_MIN} caractères (compte au rayon d'explosion le plus large de la plateforme).`;
  }
  if (!/[a-z]/.test(motDePasse) || !/[A-Z]/.test(motDePasse) || !/\d/.test(motDePasse) || !/[^a-zA-Z0-9]/.test(motDePasse)) {
    return 'ADMIN_PASSWORD doit contenir au moins une minuscule, une majuscule, un chiffre et un caractère spécial.';
  }
  const mdpMinuscule = motDePasse.toLowerCase();
  const motifTrouve = ADMIN_MDP_MOTIFS_FAIBLES.find((motif) => mdpMinuscule.includes(motif));
  if (motifTrouve) {
    return `ADMIN_PASSWORD contient un motif trop prévisible ("${motifTrouve}"). Choisissez une valeur générée aléatoirement.`;
  }
  const localPartEmail = (email || '').split('@')[0].toLowerCase();
  if (localPartEmail.length >= 4 && mdpMinuscule.includes(localPartEmail)) {
    return 'ADMIN_PASSWORD ne doit pas contenir votre adresse email.';
  }
  return null;
}

if (isProd) {
  if (ADMIN_EMAILS_PAR_DEFAUT.includes(process.env.ADMIN_EMAIL)) {
    throw new Error("ADMIN_EMAIL est la valeur par défaut. Changez-la avant le déploiement en production.");
  }
  const erreurMdpAdmin = validerMotDePasseAdmin(process.env.ADMIN_PASSWORD, process.env.ADMIN_EMAIL);
  if (erreurMdpAdmin) {
    throw new Error(erreurMdpAdmin);
  }
  if (!process.env.APP_ENC_KEY) {
    throw new Error("APP_ENC_KEY est requise en production (chiffrement des données sensibles au repos). Générez-la avec : node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  }
}

/**
 * Configuration JWT
 */
const jwtConfig = {
  secret: JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  refreshSecret: JWT_REFRESH_SECRET,
  refreshExpiresIn: '7d',
  resetSecret: JWT_RESET_SECRET,
  resetExpiresIn: '1h'
};

/**
 * Configuration Bcrypt
 */
const bcryptConfig = {
  saltRounds: 12
};

/**
 * Rate Limiting (anti brute force)
 */
// Filet de sécurité global par IP (anti-scan/DDoS) — appliqué à TOUTES les
// routes, y compris publiques (login, register) avant qu'un utilisateur
// soit identifié. Volontairement large : la limite fine par utilisateur
// (authenticatedRateLimitConfig) prend le relais sur les routes
// authentifiées pour éviter que plusieurs comptes derrière la même IP
// (4G, box partagée) ne se bloquent mutuellement.
const rateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false
};

// Limite par utilisateur authentifié (clé = req.user.id, pas l'IP) — couvre
// l'usage normal de l'app (un écran peut déclencher plusieurs appels API
// en parallèle) sans dépendre du nombre d'utilisateurs partageant une IP.
const authenticatedRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.' }
};

const authRateLimitConfig = {
  // Overridables par env (AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_MIN) pour
  // ajuster la sensibilité en déploiement (ou desserrer en test d'intégration).
  windowMs: (parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MIN || '15', 10)) * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de tentatives. Veuillez réessayer dans 15 minutes.' }
};

// Routes de mutation sensibles (modifier profil, changer mdp, supprimer compte)
const mutationRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.' }
};

// Routes admin (toutes protégées par auth admin, mais on limite quand même)
const adminRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes admin. Veuillez réessayer.' }
};

// OTP par email : 3 tentatives par email par 15 min (anti ciblage multi-IP)
const otpEmailRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de tentatives pour cet email. Réessayez dans 15 minutes.' }
};

/**
 * CORS sécurisé
 */
const corsConfig = {
  origin: _rawCorsOrigins.length ? _rawCorsOrigins : ['http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

/**
 * Cookies (si refresh token)
 */
const cookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict'
};

/**
 * Upload fichiers (PDF / Signature)
 */
const uploadConfig = {
  maxFileSize: 5 * 1024 * 1024, // 5 MB — documents, plans, photos
  // Les vidéos et notes vocales sont volumineuses par nature : un plafond
  // distinct évite de relever la limite pour TOUS les uploads.
  maxMediaSize: parseInt(process.env.UPLOAD_MAX_MEDIA_MB || '100', 10) * 1024 * 1024,
  allowedMimeTypes: [
    'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
    // Vidéos et notes vocales — module 5 du cahier des charges. Le modèle
    // Media les prévoyait (ENUM photo/video/audio) mais la liste blanche les
    // rejetait, rendant la fonctionnalité inatteignable.
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-m4a', 'audio/webm',
  ],
};

/**
 * Chiffrement & Hash
 */
const cryptoConfig = {
  hashAlgorithm: 'sha256',
  encoding: 'hex'
};

module.exports = {
  jwtConfig,
  bcryptConfig,
  rateLimitConfig,
  authenticatedRateLimitConfig,
  authRateLimitConfig,
  mutationRateLimitConfig,
  adminRateLimitConfig,
  otpEmailRateLimitConfig,
  corsConfig,
  cookieConfig,
  uploadConfig,
  cryptoConfig,
  validerMotDePasseAdmin, // exporté pour les tests (src/__tests__/) — voir la doc de la fonction
};
