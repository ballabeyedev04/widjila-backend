'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { CorpsEtat, Reserve, Phase, Chantier } = require('../../../models/index.js');
const escapeLike = require('../../../utils/escapeLike.js');

/**
 * Corps d'état — catalogue des métiers / types de travaux du BTP.
 * Voir `src/models/corpsEtat.model.js` pour la portée (`organisationId`).
 *
 * RÈGLE DE VISIBILITÉ, appliquée partout dans ce service : une organisation
 * voit le catalogue STANDARD (`organisation_id IS NULL`) **et** ses propres
 * métiers. Elle ne voit jamais ceux d'une autre organisation.
 *
 * RÈGLE D'ÉCRITURE : on ne modifie que ce qu'on possède.
 *   - le catalogue standard n'appartient qu'au super-admin plateforme ;
 *   - une organisation ne touche qu'aux lignes qu'elle a créées.
 * Sans cette seconde garde, n'importe quel chef de projet pouvait renommer
 * « Plomberie » pour TOUS les clients de la plateforme.
 */
class CorpsEtatService {

  /** Filtre de visibilité : le standard + les métiers de l'organisation. */
  static _visibilite(organisationId) {
    if (!organisationId) return { organisationId: null };
    return { [Op.or]: [{ organisationId: null }, { organisationId }] };
  }

  /**
   * Liste paginée.
   *
   * @param {string|null} organisationId  Organisation du demandeur.
   * @param {object} options
   * @param {boolean} [options.toutesOrganisations]  Super-admin : voit tout.
   *   Posé par le contrôleur d'après le RÔLE, jamais d'après la requête.
   */
  static async lister(organisationId, {
    page = 1, limit = 20, search = '', actif, organisationCible,
  } = {}, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations
      ? {}
      : CorpsEtatService._visibilite(organisationId);

    // Filtre facultatif du super-admin sur une organisation précise.
    if (toutesOrganisations && organisationCible) where.organisationId = organisationCible;

    if (actif !== undefined) where.actif = actif;

    if (search && search.trim()) {
      const motif = `%${escapeLike(search.trim())}%`;
      const recherche = { [Op.or]: [{ nom: { [Op.iLike]: motif } }, { code: { [Op.iLike]: motif } }] };
      // `Op.and` explicite : écrire `where[Op.or]` une seconde fois écraserait
      // le filtre de visibilité, et la recherche ferait alors remonter les
      // métiers des autres organisations.
      where[Op.and] = [...(where[Op.and] || []), recherche];
    }

    const { rows, count } = await CorpsEtat.findAndCountAll({
      where,
      // Ordre du chantier puis alphabétique — voir `ordre` dans le modèle.
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { success: true, corpsEtat: rows, total: count, page, limit };
  }

  /** Liste NON paginée des métiers actifs — alimente les listes déroulantes. */
  static async listerActifs(organisationId) {
    const corpsEtat = await CorpsEtat.findAll({
      where: { ...CorpsEtatService._visibilite(organisationId), actif: true },
      attributes: ['id', 'nom', 'code', 'description', 'ordre', 'organisationId'],
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
    });
    return { success: true, corpsEtat };
  }

  static async detail(organisationId, id, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations ? { id } : { id, ...CorpsEtatService._visibilite(organisationId) };
    const corpsEtat = await CorpsEtat.findOne({ where });
    if (!corpsEtat) return { success: false, message: 'Corps d’état introuvable' };
    return { success: true, corpsEtat };
  }

  /**
   * Charge une ligne MODIFIABLE par le demandeur.
   *
   * Distingue trois situations, pour que le message dise la vérité :
   *   - introuvable (ou appartenant à une autre organisation) ;
   *   - ligne du catalogue standard, réservée au super-admin ;
   *   - modifiable.
   */
  static async _pourEcriture(organisationId, id, { superAdmin = false } = {}) {
    const corpsEtat = await CorpsEtat.findByPk(id);
    if (!corpsEtat) return { erreur: 'Corps d’état introuvable' };

    if (superAdmin) return { corpsEtat };

    if (corpsEtat.organisationId === null) {
      return { erreur: 'Ce corps d’état fait partie du catalogue standard et ne peut pas être modifié ici' };
    }
    if (corpsEtat.organisationId !== organisationId) {
      return { erreur: 'Corps d’état introuvable' };
    }
    return { corpsEtat };
  }

  /** Traduit une collision d'index unique en message métier. */
  static _messageCollision(err) {
    if (err instanceof UniqueConstraintError) {
      return 'Un corps d’état porte déjà ce nom';
    }
    return null;
  }

  /**
   * Répartition des réserves d'un corps d'état PAR PHASE.
   *
   * C'est l'en-tête de l'écran d'historique : « Électricité → Pré-cloisons 3,
   * Cloisons 5, OPR 2 ». La LISTE des réserves, elle, s'obtient par
   * `GET /reserves?corpsEtatId=…&phaseId=…` — inutile de la redonner ici, elle
   * est paginée et filtrable de son côté.
   *
   * Le comptage passe par une jointure sur `Chantier` : sans elle, un
   * identifiant de corps d'état deviné révélerait le volume de réserves
   * d'une autre organisation.
   *
   * Les réserves SANS phase (créées avant que la règle existe) sont comptées
   * à part plutôt qu'ignorées : les taire ferait un total qui ne correspond
   * à rien.
   */
  static async historiqueParPhase(organisationId, id, { toutesOrganisations = false } = {}) {
    const { success, message, corpsEtat } = await CorpsEtatService.detail(
      organisationId, id, { toutesOrganisations }
    );
    if (!success) return { success: false, message };

    const lignes = await Reserve.findAll({
      where: { corpsEtatId: id },
      attributes: [
        'phaseId',
        [Reserve.sequelize.fn('COUNT', Reserve.sequelize.col('Reserve.id')), 'total'],
      ],
      include: [
        {
          model: Chantier, as: 'chantier', attributes: [], required: true,
          where: toutesOrganisations && !organisationId ? {} : { organisationId },
        },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
      ],
      group: ['Reserve.phase_id', 'phase.id'],
      order: [[{ model: Phase, as: 'phase' }, 'ordre', 'ASC']],
      raw: true,
      nest: true,
    });

    const repartition = lignes.map((l) => ({
      phaseId: l.phaseId,
      phaseNom: l.phase && l.phase.nom ? l.phase.nom : null,
      ordre: l.phase && l.phase.ordre != null ? l.phase.ordre : null,
      total: Number(l.total) || 0,
    }));

    return {
      success: true,
      corpsEtat,
      repartition,
      total: repartition.reduce((somme, l) => somme + l.total, 0),
    };
  }

  static async creer(organisationId, data, { superAdmin = false } = {}) {
    // Le super-admin alimente le catalogue STANDARD (organisationId null) ;
    // une organisation crée pour elle-même. Le client ne choisit pas.
    const portee = superAdmin ? (data.organisationId ?? null) : organisationId;

    try {
      const corpsEtat = await CorpsEtat.create({
        organisationId: portee,
        nom: data.nom,
        code: data.code || null,
        description: data.description || null,
        ordre: data.ordre ?? 0,
        actif: data.actif ?? true,
      });
      return { success: true, message: 'Corps d’état créé avec succès', corpsEtat };
    } catch (err) {
      const collision = CorpsEtatService._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  static async modifier(organisationId, id, data, { superAdmin = false } = {}) {
    const { corpsEtat, erreur } = await CorpsEtatService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const updates = {};
    for (const champ of ['nom', 'code', 'description', 'ordre', 'actif']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    // `code` et `description` vidés doivent redevenir NULL, pas ''.
    if (updates.code === '') updates.code = null;
    if (updates.description === '') updates.description = null;

    try {
      await corpsEtat.update(updates);
      return { success: true, message: 'Corps d’état modifié avec succès', corpsEtat };
    } catch (err) {
      const collision = CorpsEtatService._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  /** Bascule actif/inactif — le geste courant du catalogue. */
  static async basculerActif(organisationId, id, actif, { superAdmin = false } = {}) {
    const { corpsEtat, erreur } = await CorpsEtatService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    await corpsEtat.update({ actif });
    return {
      success: true,
      message: actif ? 'Corps d’état activé' : 'Corps d’état désactivé',
      corpsEtat,
    };
  }

  /**
   * Suppression.
   *
   * REFUSÉE tant que des réserves s'y rattachent, et le message dit combien.
   * Le geste attendu dans ce cas est la DÉSACTIVATION : la ligne cesse d'être
   * proposée dans les formulaires, sans que les réserves déjà classées
   * perdent leur métier. Supprimer d'office les aurait laissées sans
   * catégorie, alors que rien ne le demandait.
   */
  static async supprimer(organisationId, id, { superAdmin = false } = {}) {
    const { corpsEtat, erreur } = await CorpsEtatService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const nbReserves = await Reserve.count({ where: { corpsEtatId: id } });
    if (nbReserves > 0) {
      return {
        success: false,
        message: nbReserves === 1
          ? '1 réserve utilise ce corps d’état. Désactivez-le plutôt que de le supprimer.'
          : `${nbReserves} réserves utilisent ce corps d’état. Désactivez-le plutôt que de le supprimer.`,
      };
    }

    await corpsEtat.destroy();
    return { success: true, message: 'Corps d’état supprimé' };
  }
}

module.exports = CorpsEtatService;
