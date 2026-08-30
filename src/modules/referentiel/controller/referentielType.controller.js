'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');

/**
 * Contrôleur générique des référentiels de TYPE.
 *
 * Fabrique les six handlers d'un référentiel à partir de son service. Les
 * trois référentiels partagent exactement le même contrat HTTP ; les écrire
 * trois fois les aurait fait diverger.
 *
 * Le super-admin plateforme (`role: 'Admin'`) n'appartient à AUCUNE
 * organisation : c'est lui qui tient le catalogue STANDARD. Le drapeau dérive
 * donc du RÔLE, jamais d'un paramètre de requête — un client qui enverrait
 * `?superAdmin=true` n'obtiendrait rien.
 */
const estSuperAdmin = (user) => user?.role === 'Admin';

/** `?actif=true|false` — absent ou vide = pas de filtre. */
const lireActif = (valeur) => {
  if (valeur === undefined || valeur === '') return undefined;
  return valeur === 'true' || valeur === true;
};

/**
 * @param {object} config
 * @param {import('../service/referentielType.service.js')} config.service
 * @param {string} config.pluriel  « Types de document » — en-tête des réponses.
 */
function creerControleur({ service, pluriel }) {
  return {
    lister: asyncHandler(async (req, res) => {
      const result = await service.lister(
        req.user.organisationId,
        {
          // `req.query` est déjà plafonné par le middleware `paginate()`.
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
          search: req.query.search,
          actif: lireActif(req.query.actif),
          organisationCible: req.query.organisationId,
        },
        { toutesOrganisations: estSuperAdmin(req.user) }
      );
      if (!result.success) throw new BadRequestError(result.message);

      res.status(200).json({
        success: true,
        message: `${pluriel} récupérés`,
        data: {
          types: result.types,
          pagination: { total: result.total, page: result.page, limit: result.limit },
        },
      });
    }),

    /**
     * Liste des types ACTIFS, non paginée — c'est elle que consomment les
     * listes déroulantes du web et du mobile. Ouverte à tout membre
     * authentifié : choisir le type d'un document n'est pas une opération
     * d'administration.
     */
    listerActifs: asyncHandler(async (req, res) => {
      const result = await service.listerActifs(req.user.organisationId);
      res.status(200).json({
        success: true,
        message: `${pluriel} actifs récupérés`,
        data: { types: result.types },
      });
    }),

    detail: asyncHandler(async (req, res) => {
      const result = await service.detail(req.user.organisationId, req.params.id, {
        toutesOrganisations: estSuperAdmin(req.user),
      });
      if (!result.success) throw new BadRequestError(result.message);
      res.status(200).json({ success: true, message: 'Détail récupéré', data: { type: result.type } });
    }),

    creer: asyncHandler(async (req, res) => {
      const result = await service.creer(req.user.organisationId, req.body, {
        superAdmin: estSuperAdmin(req.user),
      });
      if (!result.success) throw new BadRequestError(result.message);
      res.status(201).json({ success: true, message: result.message, data: { type: result.type } });
    }),

    modifier: asyncHandler(async (req, res) => {
      const result = await service.modifier(req.user.organisationId, req.params.id, req.body, {
        superAdmin: estSuperAdmin(req.user),
      });
      if (!result.success) throw new BadRequestError(result.message);
      res.status(200).json({ success: true, message: result.message, data: { type: result.type } });
    }),

    basculerActif: asyncHandler(async (req, res) => {
      const result = await service.basculerActif(
        req.user.organisationId, req.params.id, req.body.actif,
        { superAdmin: estSuperAdmin(req.user) }
      );
      if (!result.success) throw new BadRequestError(result.message);
      res.status(200).json({ success: true, message: result.message, data: { type: result.type } });
    }),

    supprimer: asyncHandler(async (req, res) => {
      const result = await service.supprimer(req.user.organisationId, req.params.id, {
        superAdmin: estSuperAdmin(req.user),
      });
      // 400 et non 404 : le refus le plus fréquent est « des enregistrements
      // l'utilisent », qui n'est pas une absence de ressource. Le message
      // porte le nombre, c'est lui qui guide vers la désactivation.
      if (!result.success) throw new BadRequestError(result.message);
      res.status(200).json({ success: true, message: result.message });
    }),
  };
}

module.exports = creerControleur;
