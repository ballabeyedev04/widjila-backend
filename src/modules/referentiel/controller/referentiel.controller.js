'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { VUE_PUBLIQUE } = require('../../../config/enums.js');
const { VUE_PUBLIQUE: PAYS } = require('../../../config/pays.js');
const CodeNiveauService = require('../service/codeNiveau.service.js');
const CodeAppartementService = require('../service/codeAppartement.service.js');
const { BadRequestError } = require('../../../errors/AppError.js');

/**
 * Énumérations métier servies aux clients.
 *
 * Le web et le mobile recopiaient ces listes à la main. Un statut ajouté au
 * backend restait alors invisible côté client : le filtre ne le proposait pas,
 * et le badge s'affichait sans libellé. Cet endpoint supprime la recopie.
 *
 * Ce qui est renvoyé, ce sont les CODES bruts stockés en base. Les libellés
 * restent traduits côté client, pour suivre la langue de l'utilisateur.
 *
 * Contenu strictement statique et non confidentiel : le cache HTTP long est
 * délibéré, ces listes ne changent qu'avec une migration et un déploiement.
 */
exports.getEnums = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    success: true,
    message: 'Référentiels récupérés',
    data: { enums: VUE_PUBLIQUE },
  });
});

/**
 * Pays proposés à l'inscription, et les identifiants d'entreprise de chacun.
 *
 * Le formulaire affichait SIRET, RCCM et NINEA à tout le monde : une
 * entreprise française se voyait demander un NINEA, une entreprise malienne
 * n'avait nulle part où saisir son NIF. Les clients lisent désormais cette
 * liste pour n'afficher que les champs qui ont un sens.
 *
 * PUBLIQUE et sans authentification : c'est un formulaire d'INSCRIPTION,
 * l'utilisateur n'a par définition pas encore de session.
 */
exports.getPays = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    success: true,
    message: 'Pays récupérés',
    data: { pays: PAYS },
  });
});

// ── Codes de niveau (SS1, RDC, R+1…) ─────────────────────────────────────────

/**
 * Codes proposés à la saisie d'un niveau, par section.
 *
 * Pas de cache HTTP, contrairement à `/enums` : cette liste s'enrichit depuis
 * le mobile, et un cache d'une heure ferait disparaître pendant une heure le
 * code que l'utilisateur vient lui-même de créer.
 */
exports.listerCodesNiveau = asyncHandler(async (req, res) => {
  const result = await CodeNiveauService.lister(req.user.organisationId, {
    typeNiveau: req.query.typeNiveau,
  });
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Codes de niveau récupérés',
    data: { codes: result.codes },
  });
});

/** Le « + » de l'écran de dépôt : créer un code absent de la liste. */
exports.creerCodeNiveau = asyncHandler(async (req, res) => {
  const result = await CodeNiveauService.creer(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { code: result.code },
  });
});

exports.desactiverCodeNiveau = asyncHandler(async (req, res) => {
  const result = await CodeNiveauService.desactiver(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// ── Codes d'APPARTEMENT ─────────────────────────────────────────────────────
//
// Même contrat que les codes de niveau : le client a demandé la même mécanique
// — une liste servie par le serveur, et un « + » qui ajoute pour toute
// l'organisation.

exports.listerCodesAppartement = asyncHandler(async (req, res) => {
  const result = await CodeAppartementService.lister(req.user.organisationId);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Codes d\u2019appartement r\u00e9cup\u00e9r\u00e9s',
    data: { codes: result.codes },
  });
});

exports.creerCodeAppartement = asyncHandler(async (req, res) => {
  const result = await CodeAppartementService.creer(req.user.organisationId, req.body);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { code: result.code },
  });
});

exports.desactiverCodeAppartement = asyncHandler(async (req, res) => {
  const result = await CodeAppartementService.desactiver(req.user.organisationId, req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
