'use strict';

const ReserveService = require('../service/reserve.service.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError, NotFoundError } = require('../../../errors/AppError.js');
const { organisationCible, estSuperAdmin } = require('../../../utils/organisationRequete.js');

/**
 * Une réserve n'a pas d'`organisationId` : elle la tient de son chantier —
 * voir utils/organisationRequete.js. À la création, le chantier arrive dans le
 * corps de la requête ; ailleurs, `:id` désigne la réserve.
 */
const orgDeReserve = (req) => organisationCible(req, { reserveId: req.params.id });

exports.creerReserve = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.body.chantierId });
  const result = await ReserveService.creerReserve(organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.listerReserves = asyncHandler(async (req, res) => {
  const result = await ReserveService.listReserves(await organisationCible(req, { chantierId: req.params.chantierId }), req.params.chantierId, req.query);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.listerToutesReserves = asyncHandler(async (req, res) => {
  // Liste transversale (tous chantiers) : rien dans l'URL ne désigne
  // l'organisation. Le super-admin voit donc toutes les organisations, avec
  // `?organisationId=` en filtre facultatif — même règle que la liste des
  // chantiers et celle des plans. Le drapeau dérive du RÔLE seul.
  const superAdmin = estSuperAdmin(req.user);
  const result = await ReserveService.listToutesReserves(
    superAdmin ? (req.query.organisationId || null) : req.user.organisationId,
    req.query,
    { toutesOrganisations: superAdmin }
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Réserves récupérées',
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.detailReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.getReserve(req.params.id, await orgDeReserve(req));
  if (!result.success) throw new NotFoundError(result.message);
  res.status(200).json({ success: true, message: 'Réserve récupérée', data: { reserve: result.reserve } });
});

exports.modifierReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.modifierReserve(await orgDeReserve(req), req.params.id, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.changerStatut = asyncHandler(async (req, res) => {
  const result = await ReserveService.changerStatut(
    await orgDeReserve(req),
    req.params.id,
    req.body.statut,
    req.body,
    req.user.id,
    req.user.role
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

exports.supprimerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.supprimerReserve(await orgDeReserve(req), req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});

// -------------------- SÉRIE & DUPLICATION (module 5) --------------------
exports.creerSerieReserves = asyncHandler(async (req, res) => {
  const organisationId = await organisationCible(req, { chantierId: req.body.chantierId });
  const result = await ReserveService.creerReserveSerie(organisationId, req.body, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({
    success: true,
    message: result.message,
    data: { reserves: result.reserves, total: result.total },
  });
});

exports.dupliquerReserve = asyncHandler(async (req, res) => {
  const result = await ReserveService.dupliquerReserve(await orgDeReserve(req), req.params.id, req.user.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { reserve: result.reserve } });
});

// -------------------- COMMENTAIRES --------------------
exports.ajouterCommentaire = asyncHandler(async (req, res) => {
  const result = await ReserveService.ajouterCommentaire(
    await orgDeReserve(req),
    req.params.id,
    req.body.message,
    req.user.id
  );
  if (!result.success) throw new BadRequestError(result.message);
  res.status(201).json({ success: true, message: result.message, data: { commentaire: result.commentaire } });
});

exports.listerCommentaires = asyncHandler(async (req, res) => {
  const result = await ReserveService.listCommentaires(await orgDeReserve(req), req.params.id);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({
    success: true,
    message: 'Commentaires récupérés',
    data: { commentaires: result.commentaires },
  });
});
