'use strict';

const { Op } = require('sequelize');
const { Partenaire, Chantier } = require('../../../models/index.js');

/**
 * Partenaire — clients (MOA), maîtres d'œuvre, sous-traitants, fournisseurs,
 * bureaux de contrôle liés à l'organisation ou à un chantier (module 2).
 */
class PartenaireService {

  static async creerPartenaire(organisationId, data) {
    if (data.chantierId) {
      const chantier = await Chantier.findOne({ where: { id: data.chantierId, organisationId } });
      if (!chantier) return { success: false, message: 'Chantier introuvable' };
    }

    const partenaire = await Partenaire.create({
      organisationId,
      chantierId: data.chantierId || null,
      nom: data.nom,
      type: data.type || 'client',
      email: data.email ? data.email.toLowerCase() : null,
      telephone: data.telephone || null,
      contact: data.contact || null,
      adresse: data.adresse || null,
      notes: data.notes || null,
      actif: data.actif !== undefined ? data.actif : true,
    });

    return { success: true, message: 'Partenaire ajouté avec succès', partenaire };
  }

  /**
   * L'annuaire ACCESSIBLE à un chantier : ses propres fiches, plus celles de
   * l'organisation (`chantierId` nul), communes à tous ses chantiers.
   *
   * Un intervenant ajouté depuis la page « Intervenants » est rangé au niveau
   * de l'organisation. Filtrer sur le seul `chantierId` le rendait invisible
   * dans le filtre « Entreprise » des rapports, alors qu'il pouvait déjà être
   * « Entreprise concernée » d'une réserve de ce chantier.
   */
  static whereAnnuaireChantier(organisationId, chantierId) {
    return { organisationId, [Op.or]: [{ chantierId }, { chantierId: null }] };
  }

  /** [whereAnnuaireChantier] quand seul le chantier est connu. */
  static async annuaireDuChantier(chantierId) {
    const chantier = await Chantier.findByPk(chantierId, { attributes: ['organisationId'] });
    // Chantier introuvable : une condition qui ne remonte rien plutôt qu'un
    // annuaire élargi par erreur.
    if (!chantier) return { id: null };
    return PartenaireService.whereAnnuaireChantier(chantier.organisationId, chantierId);
  }

  static async listPartenaires(organisationId, chantierId = null, { type, actif } = {}) {
    const where = chantierId
      ? PartenaireService.whereAnnuaireChantier(organisationId, chantierId)
      : { organisationId };
    if (type) where.type = type;
    // `actif` arrive en chaîne depuis la query string : on ne filtre que sur
    // une valeur EXPLICITE, sinon la liste renvoie actifs et inactifs (le
    // client décide de ce qu'il affiche).
    if (actif === true || actif === 'true') where.actif = true;
    else if (actif === false || actif === 'false') where.actif = false;

    // Les actifs d'abord, puis l'alphabétique : les fiches archivées ne
    // s'intercalent pas au milieu de l'annuaire courant.
    const partenaires = await Partenaire.findAll({
      where,
      order: [['actif', 'DESC'], ['nom', 'ASC']],
    });
    return { success: true, partenaires };
  }

  static async modifierPartenaire(organisationId, partenaireId, data) {
    const partenaire = await Partenaire.findOne({ where: { id: partenaireId, organisationId } });
    if (!partenaire) return { success: false, message: 'Partenaire introuvable' };

    const updates = {};
    for (const champ of ['nom', 'type', 'email', 'telephone', 'contact', 'adresse', 'notes', 'chantierId', 'actif']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (updates.email) updates.email = updates.email.toLowerCase();

    await partenaire.update(updates);
    return { success: true, message: 'Partenaire mis à jour', partenaire };
  }

  static async supprimerPartenaire(organisationId, partenaireId) {
    const partenaire = await Partenaire.findOne({ where: { id: partenaireId, organisationId } });
    if (!partenaire) return { success: false, message: 'Partenaire introuvable' };

    await partenaire.destroy(); // soft delete
    return { success: true, message: 'Partenaire supprimé' };
  }
}

module.exports = PartenaireService;
