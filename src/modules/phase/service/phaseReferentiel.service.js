'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { Phase, Reserve } = require('../../../models/index.js');
const escapeLike = require('../../../utils/escapeLike.js');

/**
 * Référentiel des phases de chantier — Pré-cloisons, Cloisons, OPR,
 * Réception, GPA… C'est la liste à laquelle chaque réserve se rattache.
 *
 * NE CONCERNE QUE LES LIGNES DE RÉFÉRENTIEL, c'est-à-dire `chantierId IS
 * NULL`. Les phases de PLANNING d'un chantier (avec dates et statut) restent
 * gérées par `ChantierService` et ses routes `/chantiers/:id/phases` :
 * les deux usages partagent la table `phases` mais jamais leurs opérations.
 * Voir `src/models/phase.model.js`.
 *
 * VISIBILITÉ : une organisation voit le référentiel STANDARD
 * (`organisationId IS NULL`) et ses propres phases. Jamais celles d'une autre.
 *
 * ÉCRITURE : on ne modifie que ce qu'on possède — le référentiel standard
 * n'appartient qu'au super-admin plateforme.
 */
class PhaseReferentielService {

  /** Ne cible QUE le référentiel : jamais une phase de planning. */
  static get _referentiel() {
    return { chantierId: null };
  }

  /** Filtre de visibilité : le standard + les phases de l'organisation. */
  static _visibilite(organisationId) {
    if (!organisationId) return { ...PhaseReferentielService._referentiel, organisationId: null };
    return {
      ...PhaseReferentielService._referentiel,
      [Op.or]: [{ organisationId: null }, { organisationId }],
    };
  }

  static async lister(organisationId, {
    page = 1, limit = 20, search = '', actif,
  } = {}, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations
      ? { ...PhaseReferentielService._referentiel }
      : PhaseReferentielService._visibilite(organisationId);

    if (actif !== undefined) where.actif = actif;

    if (search && search.trim()) {
      const motif = `%${escapeLike(search.trim())}%`;
      // `Op.and` explicite : réécrire `where[Op.or]` écraserait le filtre de
      // visibilité, et la recherche ferait remonter les phases des autres
      // organisations.
      where[Op.and] = [...(where[Op.and] || []), { nom: { [Op.iLike]: motif } }];
    }

    const { rows, count } = await Phase.findAndCountAll({
      where,
      // L'ordre du chantier, pas l'alphabétique : « Décennale » ne vient pas
      // avant « Pré-cloisons ».
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { success: true, phases: rows, total: count, page, limit };
  }

  /** Phases ACTIVES, non paginées — alimente les listes déroulantes. */
  static async listerActives(organisationId) {
    const phases = await Phase.findAll({
      where: { ...PhaseReferentielService._visibilite(organisationId), actif: true },
      attributes: ['id', 'nom', 'description', 'ordre', 'organisationId'],
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
    });
    return { success: true, phases };
  }

  static async detail(organisationId, id, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations
      ? { id, ...PhaseReferentielService._referentiel }
      : { id, ...PhaseReferentielService._visibilite(organisationId) };
    const phase = await Phase.findOne({ where });
    if (!phase) return { success: false, message: 'Phase introuvable' };
    return { success: true, phase };
  }

  /**
   * Charge une phase de référentiel MODIFIABLE par le demandeur.
   *
   * Distingue trois situations, pour que le message dise la vérité :
   * introuvable, verrouillée (référentiel standard), ou modifiable.
   */
  static async _pourEcriture(organisationId, id, { superAdmin = false } = {}) {
    const phase = await Phase.findByPk(id);
    // Une phase de PLANNING (chantierId renseigné) n'est pas gérable ici :
    // la traiter comme introuvable évite qu'une route de référentiel serve à
    // modifier le calendrier d'un chantier.
    if (!phase || phase.chantierId !== null) return { erreur: 'Phase introuvable' };

    if (superAdmin) return { phase };

    if (phase.organisationId === null) {
      return { erreur: 'Cette phase fait partie du référentiel standard et ne peut pas être modifiée ici' };
    }
    if (phase.organisationId !== organisationId) {
      return { erreur: 'Phase introuvable' };
    }
    return { phase };
  }

  static _messageCollision(err) {
    if (err instanceof UniqueConstraintError) return 'Une phase porte déjà ce nom';
    return null;
  }

  static async creer(organisationId, data, { superAdmin = false } = {}) {
    const portee = superAdmin ? (data.organisationId ?? null) : organisationId;

    try {
      const phase = await Phase.create({
        chantierId: null, // ligne de référentiel, jamais de planning
        organisationId: portee,
        nom: data.nom,
        description: data.description || null,
        ordre: data.ordre ?? 0,
        actif: data.actif ?? true,
      });
      return { success: true, message: 'Phase créée avec succès', phase };
    } catch (err) {
      const collision = PhaseReferentielService._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  static async modifier(organisationId, id, data, { superAdmin = false } = {}) {
    const { phase, erreur } = await PhaseReferentielService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const updates = {};
    for (const champ of ['nom', 'description', 'ordre', 'actif']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (updates.description === '') updates.description = null;

    try {
      await phase.update(updates);
      // Renommer ou réordonner une phase NE TOUCHE PAS aux réserves : elles
      // pointent sur l'identifiant, pas sur le libellé. L'historique suit
      // donc le nouveau nom sans qu'aucune association ne change.
      return { success: true, message: 'Phase modifiée avec succès', phase };
    } catch (err) {
      const collision = PhaseReferentielService._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  static async basculerActif(organisationId, id, actif, { superAdmin = false } = {}) {
    const { phase, erreur } = await PhaseReferentielService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    // Désactiver ne touche à AUCUNE réserve : la phase disparaît des listes
    // de saisie, les réserves déjà rattachées restent consultables avec leur
    // historique intact.
    await phase.update({ actif });
    return {
      success: true,
      message: actif ? 'Phase activée' : 'Phase désactivée',
      phase,
    };
  }

  /**
   * Suppression — REFUSÉE dès qu'une réserve s'y rattache.
   *
   * C'est la règle métier centrale : l'historique d'une réserve ne doit jamais
   * être cassé parce qu'une phase a été retirée de la liste. Le geste attendu
   * est la DÉSACTIVATION, et le message le dit.
   */
  static async supprimer(organisationId, id, { superAdmin = false } = {}) {
    const { phase, erreur } = await PhaseReferentielService._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const nbReserves = await Reserve.count({ where: { phaseId: id } });
    if (nbReserves > 0) {
      return {
        success: false,
        message: nbReserves === 1
          ? '1 réserve est rattachée à cette phase. Désactivez-la plutôt que de la supprimer.'
          : `${nbReserves} réserves sont rattachées à cette phase. Désactivez-la plutôt que de la supprimer.`,
      };
    }

    await phase.destroy();
    return { success: true, message: 'Phase supprimée' };
  }
}

module.exports = PhaseReferentielService;
