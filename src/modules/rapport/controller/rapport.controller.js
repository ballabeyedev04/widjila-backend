'use strict';

const RapportService = require('../service/rapport.service.js');
const RapportEnvoiService = require('../service/rapportEnvoi.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible } = require('../../../utils/organisationRequete.js');

/**
 * Un rapport n'a pas d'`organisationId` : il la tient de son chantier — voir
 * utils/organisationRequete.js. La génération reçoit le chantier dans le corps
 * ou la query (`params.chantierId`), pas dans l'URL.
 */

exports.genererRapport = asyncHandler(async (req, res) => {
  // Le corps (validé par Joi) PRIME sur la query (non validée). L'ordre
  // inverse laissait `?chantierId=` viser un autre chantier que celui de l'URL
  // et `?type=` écraser la valeur validée — y compris par des valeurs qui
  // faisaient échouer la génération après la création d'un rapport
  // « brouillon » orphelin. Le chantier est celui du corps, recopié depuis
  // l'URL par `injectChantierId` avant la validation.
  const params = {
    ...req.query,
    ...req.body,
    chantierId: req.body?.chantierId ?? req.params?.chantierId,
  };
  const organisationId = await organisationCible(req, { chantierId: params.chantierId });

  let result;
  try {
    result = await RapportService.genererRapport(params, req.user.id, organisationId);
  } catch (err) {
    // Une étape NOMMÉE a échoué (voir `etapeGeneration`). Son message décrit ce
    // qui n'a pas marché et ce que l'utilisateur peut faire ; la cause
    // technique est déjà au journal. Le renvoyer en 400 plutôt qu'en 500 : le
    // serveur a compris la demande, c'est son exécution qui a échoué pour une
    // raison que l'appelant peut souvent lever lui-même.
    if (err.etapeRapport) throw new BadRequestError(err.message);
    throw err;
  }

  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { rapport: result.rapport } });
});

exports.listerRapports = asyncHandler(async (req, res) => {
  const result = await RapportService.listRapports(await organisationCible(req, { chantierId: req.params.chantierId }), req.params.chantierId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: 'Rapports récupérés', data: { rapports: result.rapports } });
});

exports.detailRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.getRapport(req.params.id, await organisationCible(req, { rapportId: req.params.id }));
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Rapport récupéré', data: { rapport: result.rapport } });
});

exports.supprimerRapport = asyncHandler(async (req, res) => {
  const result = await RapportService.supprimerRapport(await organisationCible(req, { rapportId: req.params.id }), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// ── Envoi du rapport aux entreprises ────────────────────────────────────────
//
// DEUX routes et non une : le client a demandé que l'utilisateur puisse
// vérifier le destinataire, les copies, le message et la pièce jointe AVANT
// d'appuyer sur « Envoyer ». `preparer` compose sans rien envoyer ; `envoyer`
// n'agit que sur la confirmation.

exports.preparerEnvoi = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportEnvoiService.preparer(req.params.id, organisationId, req.user.id);
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Envoi préparé', data: { envoi: result.envoi } });
});

exports.envoyerRapport = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { rapportId: req.params.id });
  const result = await RapportEnvoiService.envoyer(
    req.params.id,
    organisationId,
    req.user.id,
    // Le corps validé en entier : `exclure` pour les anciens clients, et les
    // choix du § 13 (destinataires, objet, message, mode) pour les nouveaux.
    { exclure: [], ...(req.body || {}) },
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { envoi: result.envoi } });
});
