'use strict';

const AuditLogService = require('../modules/admin/service/auditLog.service.js');

/**
 * Journal d'audit générique — capture automatiquement toute action MUTANTE
 * (POST/PUT/PATCH/DELETE) réussie, authentifiée, sur TOUTES les routes de
 * l'API, sans avoir à instrumenter chaque service individuellement.
 *
 * Pourquoi une middleware plutôt qu'un appel manuel dans chaque service
 * (comme gestionUtilisateur.service.js / gestionOrganisation.service.js) :
 * le journal d'audit ne couvrait jusqu'ici que les actions du super-admin
 * plateforme (2 services sur ~15 modules) — étendre "à toutes les actions"
 * en ajoutant un appel dans chaque service aurait demandé de toucher des
 * dizaines de fichiers, avec le risque bien réel d'en oublier un. Une
 * middleware montée une seule fois, tôt dans la chaîne, garantit une
 * couverture complète et ne dépend d'aucune discipline de développeur pour
 * les modules futurs.
 *
 * Ce que cette version générique NE fait PAS (contrairement aux appels
 * manuels existants, volontairement conservés tels quels) : elle ne
 * journalise aucun contenu du corps de requête (`details` reste vide) — un
 * middleware générique ne peut pas savoir, route par route, quels champs
 * sont sûrs à stocker en clair (mots de passe, jetons…). Les modules qui
 * ont besoin d'un détail riche (ex: ancien/nouveau rôle) gardent leur appel
 * manuel dédié ; celui-ci se contente d'exclure ces routes pour ne jamais
 * créer de doublon.
 *
 * Volontairement HORS PÉRIMÈTRE (déjà couvert ailleurs) :
 *   - /api/v1/admin/*  → gestionUtilisateur.service.js / gestionOrganisation.service.js
 *   - /api/v1/auth/*   → modules/auth/service/connexionLog.service.js (login/MFA)
 *   - toute route sans req.user (ex: webhook PayTech, signature-vérifiée,
 *     pas de Bearer token) — rien à attribuer à un utilisateur.
 *
 * Écriture best-effort (AuditLogService.logAction gère déjà l'échec sans
 * jamais lever) et déclenchée sur `res.on('finish')` : ne retarde ni
 * n'altère jamais la réponse déjà envoyée au client.
 */

const METHODES_AUDITEES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PREFIXES_EXCLUS = ['/api/v1/admin/', '/api/v1/auth/'];

/** POST → create, PUT/PATCH → update, DELETE → delete. */
const VERBE_PAR_METHODE = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/**
 * Déduit un nom d'action stable depuis le PATRON de route (avec `:id`, pas
 * l'URL réelle — sinon chaque appel produirait une action différente).
 * Ex: PATRON "/api/v1/chantiers/:id/membres" + POST → "chantiers.membres.create".
 */
function deriveAction(method, patron) {
  const verbe = VERBE_PAR_METHODE[method] || method.toLowerCase();
  const segments = (patron || '')
    .replace(/^\/api\/v1\//, '')
    .split('/')
    .filter(Boolean)
    .filter((s) => !s.startsWith(':'));
  return [...segments, verbe].join('.') || verbe;
}

/** Cible principale = premier paramètre de route qui ressemble à un id (id, chantierId, reserveId…). */
function deriveCible(req) {
  const params = req.params || {};
  const cle = Object.keys(params).find((k) => /id$/i.test(k));
  if (!cle) return { cibleType: null, cibleId: null };
  const type = cle.replace(/Id$/i, '');
  return { cibleType: type ? type.toLowerCase() : 'ressource', cibleId: params[cle] };
}

function auditTrail(req, res, next) {
  const cheminReel = req.originalUrl.split('?')[0];
  if (!METHODES_AUDITEES.has(req.method) || PREFIXES_EXCLUS.some((p) => cheminReel.startsWith(p))) {
    return next();
  }

  res.on('finish', () => {
    if (res.statusCode >= 400) return; // n'auditer que les actions réussies
    if (!req.user) return; // pas d'utilisateur authentifié à qui attribuer l'action

    // req.route.path est le PATRON de la route (avec :id) — seul moyen
    // d'obtenir un nom d'action stable, l'URL réelle contient un id concret.
    const patron = req.route?.path ? `${req.baseUrl}${req.route.path}` : cheminReel;
    const { cibleType, cibleId } = deriveCible(req);

    AuditLogService.logAction({
      admin: req.user,
      action: deriveAction(req.method, patron),
      cibleType,
      cibleId,
      details: null,
      ip: req.ip,
    });
  });

  next();
}

module.exports = auditTrail;
