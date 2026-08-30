'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const escapeLike = require('../../../utils/escapeLike.js');

/**
 * Service générique des référentiels de TYPE — documents, intervenants,
 * inspections.
 *
 * Les trois obéissent aux mêmes règles ; les écrire trois fois les aurait fait
 * diverger au premier correctif appliqué à un seul.
 *
 * ── RÈGLE DE VISIBILITÉ ───────────────────────────────────────────────────
 * Une organisation voit le catalogue STANDARD (`organisation_id IS NULL`) et
 * ses propres types. Jamais ceux d'une autre organisation.
 *
 * ── RÈGLE D'ÉCRITURE ──────────────────────────────────────────────────────
 * On ne modifie que ce qu'on possède :
 *   - le catalogue standard n'appartient qu'au super-admin plateforme ;
 *   - une organisation ne touche qu'aux lignes qu'elle a créées.
 * Sans cette seconde garde, un chef de projet renommerait « Plan » pour TOUS
 * les clients de la plateforme.
 *
 * ── SUPPRESSION ───────────────────────────────────────────────────────────
 * Refusée tant que des enregistrements portent le code. Le geste attendu est
 * la DÉSACTIVATION : le type cesse d'être proposé, les données déjà classées
 * gardent leur libellé.
 */
class ReferentielTypeService {
  /**
   * @param {object} config
   * @param {import('sequelize').Model} config.modele        Modèle du référentiel.
   * @param {import('sequelize').Model} config.modeleUsage   Modèle qui porte le code.
   * @param {string} config.colonneUsage                     Colonne qui porte le code.
   * @param {string} config.libelle                          « type de document »…
   * @param {string} config.libelleAccord                    « ce type de document »…
   */
  constructor({ modele, modeleUsage, colonneUsage, libelle, libelleAccord }) {
    this.modele = modele;
    this.modeleUsage = modeleUsage;
    this.colonneUsage = colonneUsage;
    this.libelle = libelle;
    this.libelleAccord = libelleAccord;
  }

  /** Filtre de visibilité : le standard + les types de l'organisation. */
  _visibilite(organisationId) {
    if (!organisationId) return { organisationId: null };
    return { [Op.or]: [{ organisationId: null }, { organisationId }] };
  }

  /** Liste paginée — écran d'administration (actifs ET inactifs). */
  async lister(organisationId, {
    page = 1, limit = 20, search = '', actif, organisationCible,
  } = {}, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations ? {} : this._visibilite(organisationId);

    if (toutesOrganisations && organisationCible) where.organisationId = organisationCible;
    if (actif !== undefined) where.actif = actif;

    if (search && search.trim()) {
      const motif = `%${escapeLike(search.trim())}%`;
      const recherche = { [Op.or]: [{ nom: { [Op.iLike]: motif } }, { code: { [Op.iLike]: motif } }] };
      // `Op.and` explicite : réécrire `where[Op.or]` écraserait le filtre de
      // visibilité, et la recherche ferait remonter les types des autres.
      where[Op.and] = [...(where[Op.and] || []), recherche];
    }

    const { rows, count } = await this.modele.findAndCountAll({
      where,
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { success: true, types: rows, total: count, page, limit };
  }

  /** Liste NON paginée des types actifs — alimente les listes déroulantes. */
  async listerActifs(organisationId) {
    const types = await this.modele.findAll({
      where: { ...this._visibilite(organisationId), actif: true },
      attributes: ['id', 'code', 'nom', 'description', 'ordre', 'organisationId'],
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
    });
    return { success: true, types };
  }

  async detail(organisationId, id, { toutesOrganisations = false } = {}) {
    const where = toutesOrganisations ? { id } : { id, ...this._visibilite(organisationId) };
    const type = await this.modele.findOne({ where });
    if (!type) return { success: false, message: `${this.libelleAccord} est introuvable` };
    return { success: true, type };
  }

  /**
   * Charge une ligne MODIFIABLE par le demandeur.
   *
   * Distingue trois situations, pour que le message dise la vérité :
   * introuvable, verrouillée (catalogue standard), ou modifiable.
   */
  async _pourEcriture(organisationId, id, { superAdmin = false } = {}) {
    const type = await this.modele.findByPk(id);
    if (!type) return { erreur: `${this.libelleAccord} est introuvable` };

    if (superAdmin) return { type };

    if (type.organisationId === null) {
      return {
        erreur: `${this.libelleAccord} fait partie du catalogue standard et ne peut pas être modifié ici`,
      };
    }
    if (type.organisationId !== organisationId) {
      // Même message que « introuvable » : dire « appartient à une autre
      // organisation » confirmerait son existence.
      return { erreur: `${this.libelleAccord} est introuvable` };
    }
    return { type };
  }

  /** Traduit une collision d'index unique en message métier. */
  _messageCollision(err) {
    if (err instanceof UniqueConstraintError) {
      return `Un ${this.libelle} porte déjà ce code`;
    }
    return null;
  }

  async creer(organisationId, data, { superAdmin = false } = {}) {
    // Le super-admin alimente le catalogue STANDARD ; une organisation crée
    // pour elle-même. Le client ne choisit pas sa portée.
    const portee = superAdmin ? (data.organisationId ?? null) : organisationId;

    try {
      const type = await this.modele.create({
        organisationId: portee,
        // Code normalisé : la colonne métier le stockera tel quel, et les
        // comparaisons du code applicatif sont sensibles à la casse.
        code: String(data.code).trim().toLowerCase(),
        nom: data.nom,
        description: data.description || null,
        ordre: data.ordre ?? 0,
        actif: data.actif ?? true,
      });
      return { success: true, message: `${this.libelleAccord} a été créé`, type };
    } catch (err) {
      const collision = this._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  async modifier(organisationId, id, data, { superAdmin = false } = {}) {
    const { type, erreur } = await this._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const updates = {};
    for (const champ of ['nom', 'description', 'ordre', 'actif']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (updates.description === '') updates.description = null;

    // Le CODE n'est volontairement PAS modifiable.
    //
    // Il est écrit dans chaque enregistrement déjà classé : le changer ici
    // orphelinerait ces lignes, qui porteraient un code que plus aucun type ne
    // décrit. Renommer le LIBELLÉ suffit dans tous les cas d'usage réels.
    if (data.code !== undefined && String(data.code).trim().toLowerCase() !== type.code) {
      return {
        success: false,
        message: 'Le code ne peut pas être modifié : il est enregistré dans les données existantes. '
          + 'Modifiez le nom, ou créez un nouveau type et désactivez celui-ci.',
      };
    }

    try {
      await type.update(updates);
      return { success: true, message: `${this.libelleAccord} a été modifié`, type };
    } catch (err) {
      const collision = this._messageCollision(err);
      if (collision) return { success: false, message: collision };
      throw err;
    }
  }

  /** Bascule actif/inactif — le geste courant du catalogue. */
  async basculerActif(organisationId, id, actif, { superAdmin = false } = {}) {
    const { type, erreur } = await this._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    await type.update({ actif });
    return {
      success: true,
      message: actif ? `${this.libelleAccord} a été activé` : `${this.libelleAccord} a été désactivé`,
      type,
    };
  }

  /** Compte les enregistrements qui portent ce code. */
  async _compterUsages(type) {
    return this.modeleUsage.count({
      where: {
        [this.colonneUsage]: type.code,
        // Le catalogue standard est partagé : un type standard est utilisé dès
        // qu'UNE organisation s'en sert. Un type propre à une organisation ne
        // compte que ses propres enregistrements — mais la colonne d'usage ne
        // porte pas toujours `organisationId` directement, et un comptage trop
        // large ne fait que REFUSER une suppression. Refuser à tort est sans
        // gravité (la désactivation reste possible) ; supprimer à tort casse
        // des données.
      },
    });
  }

  /**
   * Suppression.
   *
   * REFUSÉE tant que des enregistrements portent le code, et le message dit
   * combien. Supprimer d'office les laisserait avec un code que plus aucun
   * type ne décrit : le libellé disparaîtrait de l'écran sans prévenir.
   */
  async supprimer(organisationId, id, { superAdmin = false } = {}) {
    const { type, erreur } = await this._pourEcriture(organisationId, id, { superAdmin });
    if (erreur) return { success: false, message: erreur };

    const nb = await this._compterUsages(type);
    if (nb > 0) {
      return {
        success: false,
        message: nb === 1
          ? `1 enregistrement utilise ce ${this.libelle}. Désactivez-le plutôt que de le supprimer.`
          : `${nb} enregistrements utilisent ce ${this.libelle}. Désactivez-le plutôt que de le supprimer.`,
      };
    }

    await type.destroy();
    return { success: true, message: `${this.libelleAccord} a été supprimé` };
  }

  /**
   * Vrai si le code est utilisable par cette organisation.
   *
   * Remplace la validation `Joi.valid(...ENUM)` : la liste des valeurs
   * acceptées n'est plus figée dans le code, elle vit en base.
   */
  async codeValide(organisationId, code) {
    if (!code) return false;
    const type = await this.modele.findOne({
      where: { ...this._visibilite(organisationId), code: String(code).toLowerCase(), actif: true },
      attributes: ['id'],
    });
    return !!type;
  }
}

module.exports = ReferentielTypeService;
