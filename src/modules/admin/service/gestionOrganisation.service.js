'use strict';

const { Op } = require('sequelize');
const { Organisation, Utilisateur, Chantier } = require('../../../models/index.js');
const AuditLogService = require('./auditLog.service.js');
const AccountService = require('../../account/service/account.service.js');
const { SAFE_USER_ATTRIBUTES } = require('../../../utils/formatUser.js');
const escapeLike = require('../../../utils/escapeLike.js');

/**
 * Gestion des organisations — SUPER-ADMIN plateforme (rôle 'Admin').
 */
class GestionOrganisationService {

  // -------------------- LISTER LES ORGANISATIONS --------------------
  static async listOrganisations({ page = 1, limit = 20, search = '', statut, abonnement } = {}) {
    const where = {};
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { raison_sociale: { [Op.iLike]: motif } },
        { email: { [Op.iLike]: motif } },
      ];
    }
    if (statut) where.statut = statut;
    if (abonnement) where.abonnement = abonnement;

    const { rows, count } = await Organisation.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    // Compteurs (membres / chantiers) — une requête groupée par org
    const orgIds = rows.map((o) => o.id);
    const [membres, chantiers] = orgIds.length
      ? await Promise.all([
          Utilisateur.findAll({ where: { organisationId: orgIds }, attributes: ['organisationId'], raw: true }),
          Chantier.findAll({ where: { organisationId: orgIds }, attributes: ['organisationId'], raw: true }),
        ])
      : [[], []];

    const countBy = (rows, key) =>
      rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});

    const membresMap = countBy(membres, 'organisationId');
    const chantiersMap = countBy(chantiers, 'organisationId');

    const organisations = rows.map((o) => {
      const oj = o.toJSON();
      oj.nbMembres = membresMap[o.id] || 0;
      oj.nbChantiers = chantiersMap[o.id] || 0;
      return oj;
    });

    return { success: true, organisations, total: count };
  }

  // -------------------- DÉTAIL D'UNE ORGANISATION --------------------
  static async getOrganisation(organisationId) {
    const organisation = await Organisation.findByPk(organisationId, {
      include: [
        // Attributs sûrs uniquement — mfa_secret et compteurs ne sortent jamais.
        { model: Utilisateur, as: 'membres', attributes: SAFE_USER_ATTRIBUTES },
        { model: Chantier, as: 'chantiers' },
      ],
    });
    if (!organisation) return { success: false, message: 'Organisation introuvable' };
    return { success: true, organisation };
  }

  // -------------------- CRÉER UNE ORGANISATION --------------------
  static async creerOrganisation(data, admin, ip) {
    if (data.siret) {
      const exist = await Organisation.findOne({ where: { siret: data.siret } });
      if (exist) return { success: false, message: 'Ce SIRET est déjà utilisé' };
    }

    const organisation = await Organisation.create({
      nom: data.nom,
      raison_sociale: data.raison_sociale || data.nom,
      siret: data.siret || null,
      num_tva: data.num_tva || null,
      rccm: data.rccm || null,
      ninea: data.ninea || null,
      telephone: data.telephone || null,
      email: data.email ? data.email.toLowerCase() : null,
      adresse: data.adresse || null,
      ville: data.ville || null,
      pays: data.pays || 'France',
      abonnement: data.abonnement || 'Starter',
    });

    await AuditLogService.logAction({
      admin, action: 'organisation.creation', cibleType: 'organisation',
      cibleId: organisation.id, details: { nom: organisation.nom }, ip,
    });

    return { success: true, message: 'Organisation créée avec succès', organisation };
  }

  // -------------------- MODIFIER UNE ORGANISATION --------------------
  static async modifierOrganisation(organisationId, data, admin, ip) {
    const organisation = await Organisation.findByPk(organisationId);
    if (!organisation) return { success: false, message: 'Organisation introuvable' };

    const updates = {};
    for (const champ of ['nom', 'raison_sociale', 'siret', 'num_tva', 'rccm', 'ninea', 'telephone', 'email', 'adresse', 'ville', 'pays', 'abonnement', 'statut']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (updates.email) updates.email = updates.email.toLowerCase();

    await organisation.update(updates);

    await AuditLogService.logAction({
      admin, action: 'organisation.modification', cibleType: 'organisation',
      cibleId: organisation.id, details: updates, ip,
    });

    return { success: true, message: 'Organisation mise à jour', organisation };
  }

  // -------------------- SUPPRIMER UNE ORGANISATION --------------------
  static async supprimerOrganisation(organisationId, admin, ip) {
    const organisation = await Organisation.findByPk(organisationId);
    if (!organisation) return { success: false, message: 'Organisation introuvable' };

    // Les membres doivent être pseudonymisés AVANT la suppression de
    // l'organisation. Le `onDelete: 'CASCADE'` déclaré côté Sequelize est une
    // contrainte SQL : elle ne se déclenche que sur un vrai DELETE, jamais sur
    // le `UPDATE deleted_at` d'un soft delete. Sans cette boucle, supprimer une
    // organisation laissait en base l'intégralité des données personnelles de
    // ses membres — nom, email, téléphone, photo — sans aucune limite de durée
    // et sans qu'aucun écran ne permette de les faire disparaître.
    const membres = await Utilisateur.findAll({ where: { organisationId } });
    for (const membre of membres) {
      await AccountService.pseudonymiserEtSupprimer(membre);
    }

    await organisation.destroy(); // soft delete de l'organisation elle-même

    await AuditLogService.logAction({
      admin, action: 'organisation.suppression', cibleType: 'organisation',
      cibleId: organisation.id,
      details: { nom: organisation.nom, membresPseudonymises: membres.length },
      ip,
    });

    return { success: true, message: `Organisation supprimée (${membres.length} membre(s) pseudonymisé(s))` };
  }
}

module.exports = GestionOrganisationService;
