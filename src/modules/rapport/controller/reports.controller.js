'use strict';

const RapportsService = require('../service/rapports.service.js');
const RapportEnvoiService = require('../service/rapportEnvoi.service.js');
const RapportPartageService = require('../service/rapportPartage.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError, UnauthorizedError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');
const logger = require('../../../utils/logger.js');

/**
 * API REST du module Rapports — § 9 du cahier des charges.
 *
 *   POST   /reports                  créer la configuration
 *   GET    /reports                  lister
 *   GET    /reports/{id}             détail
 *   PATCH  /reports/{id}             modifier la configuration
 *   POST   /reports/{id}/generate    générer (§ 11)
 *   GET    /reports/{id}/preview     prévisualiser (§ 20)
 *   GET    /reports/{id}/download    télécharger
 *   POST   /reports/{id}/send-email  envoyer (§ 13)
 *   POST   /reports/{id}/share       partager par lien (§ 14)
 *   GET    /reports/{id}/history     historique (§ 18)
 *   POST   /reports/{id}/duplicate   dupliquer
 *
 * S'y ajoutent ce que le document décrit sans lui donner de route : la
 * génération par entreprise (§ 15), la révocation des liens (§ 14), la
 * préparation de l'envoi (§ 13, « Widjila propose… ») et l'archivage (§ 19).
 *
 * Un rapport n'a pas d'`organisationId` : il la tient de son chantier — voir
 * `utils/organisationRequete.js`.
 */

/** Traduit le vocabulaire du § 10 vers celui du service, sans rien perdre. */
function configuration(corps = {}) {
  const pris = (a, b) => (corps[a] !== undefined ? corps[a] : corps[b]);
  const config = {
    chantierId: pris('chantierId', 'project_id'),
    nom: pris('nom', 'name'),
    modele: pris('modele', 'template_id'),
    filtres: pris('filtres', 'filters'),
    sections: corps.sections,
    formats: pris('formats', 'format'),
  };
  // `undefined` doit rester absent : pour un PATCH, un champ absent signifie
  // « ne pas toucher », pas « remettre à vide ».
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
}

/** URL sécurisées rendues avec un rapport (§ 11, étape 12). */
function liens(rapport) {
  const base = `/api/v1/reports/${rapport.id}`;
  return {
    url: rapport.fichier_url ? `${base}/download` : null,
    xlsx_url: rapport.fichier_xlsx_url ? `${base}/download?format=xlsx` : null,
    preview_url: `${base}/preview`,
  };
}

/** Un rapport tel qu'il est renvoyé — la ligne, plus ses liens d'accès. */
function presenter(rapport) {
  const json = typeof rapport.toJSON === 'function' ? rapport.toJSON() : { ...rapport };
  return { ...json, report_id: json.id, liens: liens(json) };
}

/** Nom de fichier pour `Content-Disposition`, ASCII et UTF-8. */
function disposition(type, nom) {
  const ascii = String(nom).normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
  return `${type}; filename="${ascii || 'rapport'}"; filename*=UTF-8''${encodeURIComponent(nom)}`;
}

/**
 * Relaie un fichier privé.
 *
 * `private, no-store` : un rapport de réserves est un document contractuel ;
 * aucun proxy intermédiaire ne doit en garder de copie.
 */
function servir(res, fichier, type = 'attachment') {
  res.setHeader('Content-Type', fichier.contentType);
  res.setHeader('Content-Disposition', disposition(type, fichier.nom));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (fichier.taille) res.setHeader('Content-Length', fichier.taille);

  fichier.stream.on('error', (err) => {
    logger.error(`[rapport] Flux interrompu : ${err.message}`);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  fichier.stream.pipe(res);
}

/** Échec métier → 400 ; « introuvable » → 404. */
function echec(result) {
  if (/introuvable/i.test(result.message || '')) throw new NotFoundError(result.message);
  throw new BadRequestError(result.message);
}

/**
 * Exécute une génération en traduisant l'échec d'une étape NOMMÉE en 400.
 *
 * Le serveur a compris la demande ; c'est son exécution qui a échoué, pour
 * une raison que le message décrit. Une erreur qu'on ne sait pas nommer, en
 * revanche, reste une 500 : le contrôleur ne s'attribue pas une compréhension
 * qu'il n'a pas.
 */
async function avecEtapes(action) {
  try {
    return await action();
  } catch (err) {
    if (err.etapeRapport) throw new BadRequestError(err.message);
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Configuration
   ══════════════════════════════════════════════════════════════════════════ */

exports.modeles = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { modeles: RapportsService.modeles() } });
});

exports.creer = asyncHandler(async (req, res) => {
  const config = configuration(req.body);
  const organisationId = await organisationCible(req, { chantierId: config.chantierId });

  const result = await RapportsService.creer(config, req.user, organisationId);
  if (!result.success) echec(result);

  res.status(201).json({
    success: true,
    message: 'Rapport créé',
    data: { rapport: presenter(result.rapport), report_id: result.rapport.id },
  });
});

exports.lister = asyncHandler(async (req, res) => {
  const chantierId = req.query.project_id || req.query.chantierId;
  const organisationId = await organisationCible(req, { chantierId });

  // `auteur` : la liste sans filtre de chantier renvoyait les rapports de
  // TOUS les chantiers de l'organisation, y compris ceux que le compte ne peut
  // pas ouvrir — PDF compris, via /preview et /download.
  const result = await RapportsService.lister(organisationId, { ...req.query, chantierId }, req.user);
  res.status(200).json({
    success: true,
    data: {
      rapports: result.rapports.map(presenter),
      total: result.total,
      page: result.page,
      limit: result.limit,
    },
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.detail(req.params.id, organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, data: { rapport: presenter(result.rapport) } });
});

exports.modifier = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.modifier(req.params.id, configuration(req.body), req.user, organisationId);
  if (!result.success) echec(result);
  res.status(200).json({ success: true, message: 'Rapport modifié', data: { rapport: presenter(result.rapport) } });
});

/* ══════════════════════════════════════════════════════════════════════════
   Génération
   ══════════════════════════════════════════════════════════════════════════ */

exports.generer = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await avecEtapes(() => RapportsService.generer(req.params.id, req.user, organisationId));
  if (!result.success) echec(result);

  // § 11, étape 12 : « Retourner report_id et URL sécurisée ».
  res.status(201).json({
    success: true,
    message: result.nouvelleVersion ? 'Nouvelle version générée' : 'Rapport généré',
    data: {
      rapport: presenter(result.rapport),
      report_id: result.rapport.id,
      ...liens(result.rapport),
      nouvelleVersion: result.nouvelleVersion,
      resume: result.resume,
    },
  });
});

exports.genererParEntreprise = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await avecEtapes(() => RapportsService.genererParEntreprise(req.params.id, req.user, organisationId));
  if (!result.success && !result.rapports?.length) echec(result);

  res.status(201).json({
    success: true,
    message: result.message,
    data: {
      lot: result.lot,
      rapports: result.rapports.map(presenter),
      echecs: result.echecs,
      reservesSansEntreprise: result.reservesSansEntreprise,
    },
  });
});

exports.previsualiser = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });

  if (req.query.mode === 'resume') {
    const result = await RapportsService.resume(req.params.id, organisationId);
    if (!result.success) echec(result);
    return res.status(200).json({ success: true, data: { resume: result.resume } });
  }

  const result = await avecEtapes(() => RapportsService.previsualiser(req.params.id, organisationId, req.user));
  if (!result.success) echec(result);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', disposition('inline', result.nom));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Rapport-Reserves', String(result.resume.reserves));
  res.status(200).send(result.buffer);
});

exports.telecharger = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.fichier(req.params.id, organisationId, {
    format: req.query.format || 'pdf',
    utilisateurId: req.user.id,
  });
  if (!result.success) echec(result);
  servir(res, result, 'attachment');
});

/* ══════════════════════════════════════════════════════════════════════════
   Diffusion
   ══════════════════════════════════════════════════════════════════════════ */

exports.preparerEnvoi = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportEnvoiService.preparer(req.params.id, organisationId, req.user.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Envoi préparé', data: { envoi: result.envoi } });
});

/**
 * Clé d'idempotence d'un envoi (en-tête `Idempotency-Key`) — audit
 * synchronisation. Lue dans l'EN-TÊTE uniquement : le corps passe par Joi,
 * qui retire toute clé inconnue, et une clé n'a de sens que fixée par le
 * client pour une intention d'envoi donnée.
 */
const FORMAT_CLE_IDEMPOTENCE = /^[A-Za-z0-9_.:-]{8,128}$/;
const { AppError } = require('../../../errors/AppError.js');

exports.envoyer = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const cle = req.get('Idempotency-Key');
  if (cle !== undefined && !FORMAT_CLE_IDEMPOTENCE.test(cle)) {
    throw new BadRequestError('En-tête Idempotency-Key invalide (8 à 128 caractères : lettres, chiffres, « - _ . : »).');
  }
  // Une clé glissée dans le CORPS est écartée : seule celle de l'en-tête fait
  // foi (Joi la retire déjà en amont ; on ne s'en remet pas à lui seul).
  const { cleIdempotence: _ignoree, ...corps } = req.body || {};
  const result = await RapportEnvoiService.envoyer(
    req.params.id, organisationId, req.user.id,
    { ...corps, ...(cle ? { cleIdempotence: cle } : {}) },
  );
  if (!result.success) {
    // 409 avec un CODE : le mobile doit le lire comme « réessayer plus tard »,
    // jamais comme un refus définitif (voir SynchronisationService).
    if (result.code === 'ENVOI_EN_COURS') throw new AppError(result.message, 409, true, result.code);
    echec(result);
  }
  res.status(200).json({
    success: true,
    message: result.message,
    data: { envoi: result.envoi, rejeu: Boolean(result.rejeu) },
  });
});

exports.destinataires = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportEnvoiService.destinataires(req.params.id, organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, data: { destinataires: result.destinataires } });
});

exports.partager = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const corps = req.body || {};
  const result = await RapportPartageService.creer(req.params.id, organisationId, req.user, {
    expireDansJours: corps.expireDansJours ?? corps.expires_in_days ?? null,
    authentificationRequise: corps.authentificationRequise ?? corps.require_auth ?? false,
  });
  if (!result.success) echec(result);

  res.status(201).json({
    success: true,
    message: 'Lien de partage créé',
    data: {
      // Le lien EN CLAIR n'est rendu qu'ici, une seule fois : la base n'en
      // garde que l'empreinte.
      url: result.url,
      partage: {
        id: result.partage.id,
        expireLe: result.partage.expire_le,
        authentificationRequise: result.partage.authentification_requise,
      },
    },
  });
});

exports.listerPartages = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportPartageService.lister(req.params.id, organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, data: { partages: result.partages } });
});

exports.revoquerPartage = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportPartageService.revoquer(req.params.id, req.params.partageId, organisationId, req.user);
  if (!result.success) echec(result);
  res.status(200).json({ success: true, message: result.message });
});

/* ══════════════════════════════════════════════════════════════════════════
   Historique, duplication, archivage
   ══════════════════════════════════════════════════════════════════════════ */

exports.historique = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.historique(req.params.id, organisationId);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, data: { historique: result.historique } });
});

exports.dupliquer = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.dupliquer(req.params.id, req.user, organisationId);
  if (!result.success) echec(result);
  res.status(201).json({
    success: true,
    message: 'Rapport dupliqué',
    data: { rapport: presenter(result.rapport), report_id: result.rapport.id },
  });
});

exports.archiver = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.archiver(req.params.id, req.user, organisationId);
  if (!result.success) echec(result);
  res.status(200).json({ success: true, message: 'Rapport archivé', data: { rapport: presenter(result.rapport) } });
});

exports.supprimer = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportsService.supprimer(req.params.id, req.user, organisationId);
  if (!result.success) echec(result);
  res.status(200).json({ success: true, message: result.message });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 14 — Lien public
   ══════════════════════════════════════════════════════════════════════════ */

/** Page d'erreur minimale : ce lien s'ouvre dans un navigateur, pas dans l'API. */
function pageErreur(res, statut, message) {
  const texte = String(message).replace(/[<>&"]/g, '');
  res.status(statut)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Widjila</title></head>
<body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f3f5f8;margin:0;padding:40px 16px;color:#0f172a">
<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<p style="color:#f2600c;font-weight:700;margin:0 0 10px">WIDJILA</p><p style="margin:0">${texte}</p></div></body></html>`);
}

exports.ouvrirLienPublic = async (req, res, next) => {
  try {
    const result = await RapportPartageService.ouvrir(req.params.token, {
      utilisateur: req.user || null,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (!result.success) {
      return pageErreur(res, result.authentificationRequise ? 401 : 404, result.message);
    }
    servir(res, result, 'inline');
  } catch (err) {
    next(err);
  }
};

exports._interne = { configuration, disposition, liens, UnauthorizedError };
