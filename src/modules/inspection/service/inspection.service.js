'use strict';

const {
  Inspection, Checklist, ChecklistModele, Chantier, Utilisateur,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');

class InspectionService {

  /**
   * CORRECTIF (audit § 8) — référence inter-tenant non validée.
   * `inspecteurId` était repris tel quel depuis le corps de la requête : on
   * pouvait désigner comme inspecteur l'utilisateur d'une AUTRE organisation,
   * qui se retrouvait nommé sur un PV d'inspection sans y avoir accès.
   */
  static async _verifierInspecteur(organisationId, inspecteurId) {
    const inspecteur = await Utilisateur.findOne({ where: { id: inspecteurId, organisationId } });
    if (!inspecteur) return 'Inspecteur non rattaché à votre organisation';
    return null;
  }

  // -------------------- CRÉER UNE INSPECTION --------------------
  static async creerInspection(organisationId, data, utilisateurId) {
    const chantier = await Chantier.findOne({ where: { id: data.chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    if (data.inspecteurId) {
      const erreur = await InspectionService._verifierInspecteur(organisationId, data.inspecteurId);
      if (erreur) return { success: false, message: erreur };
    }

    // Le modèle de checklist est chargé AVANT la transaction (lecture seule)
    let itemsModele = null;
    if (data.modeleId) {
      const modele = await ChecklistModele.findOne({ where: { id: data.modeleId, organisationId } });
      if (modele && Array.isArray(modele.items) && modele.items.length) itemsModele = modele.items;
    }

    // CORRECTIF (audit § 2) — atomicité. Inspection + bulkCreate de checklist
    // étaient trois écritures indépendantes : un échec sur la checklist
    // laissait une inspection vide, indiscernable d'une inspection sans
    // contrôle prévu, que l'inspecteur signait ensuite « conforme ».
    const t = await sequelize.transaction();
    let inspection;
    try {
      inspection = await Inspection.create({
        chantierId: data.chantierId,
        inspecteurId: data.inspecteurId || utilisateurId,
        type: data.type || 'inspection',
        date_visite: data.date_visite || null,
      }, { transaction: t });

      // Checklist personnalisée (libellés fournis à la création)
      if (data.checklist && data.checklist.length) {
        await Checklist.bulkCreate(
          data.checklist.map((c) => ({
            inspectionId: inspection.id,
            libelle: c.libelle,
            coche: c.coche || false,
            commentaire: c.commentaire || null,
          })),
          { transaction: t }
        );
      }

      // Préremplissage depuis un modèle réutilisable (module 6)
      if (itemsModele) {
        await Checklist.bulkCreate(
          itemsModele.map((item) => ({
            inspectionId: inspection.id,
            libelle: (typeof item === 'string' ? item : item.libelle) || 'Sans libellé',
            coche: false,
            commentaire: null,
          })),
          { transaction: t }
        );
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Inspection créée avec succès', inspection };
  }

  // -------------------- LISTER LES INSPECTIONS D'UN CHANTIER --------------------
  static async listInspections(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const inspections = await Inspection.findAll({
      where: { chantierId },
      include: [
        { model: Utilisateur, as: 'inspecteur', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Checklist, as: 'checklist' },
      ],
      order: [
        ['date_visite', 'DESC'],
        ['createdAt', 'DESC'],
        // Ordre des lignes de contrôle — exprimé au niveau supérieur (cf. getInspection)
        [{ model: Checklist, as: 'checklist' }, 'createdAt', 'ASC'],
      ],
    });
    return { success: true, inspections };
  }

  // -------------------- DÉTAIL D'UNE INSPECTION --------------------
  static async getInspection(inspectionId, organisationId) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [
        // Scoping multi-tenant : le chantier doit appartenir à l'organisation
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom'] },
        { model: Utilisateur, as: 'inspecteur', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Checklist, as: 'checklist' },
      ],
      // CORRECTIF (audit § 9) — un `order` placé DANS un include est ignoré par
      // Sequelize : les lignes de checklist sortaient dans l'ordre arbitraire du
      // plan d'exécution Postgres, alors qu'une checklist n'a de sens que dans
      // l'ordre où elle a été rédigée. Le tri est exprimé au niveau supérieur.
      order: [[{ model: Checklist, as: 'checklist' }, 'createdAt', 'ASC']],
    });
    if (!inspection || !inspection.chantier) {
      return { success: false, message: 'Inspection introuvable dans cette organisation' };
    }
    return { success: true, inspection };
  }

  // -------------------- MODIFIER UNE INSPECTION --------------------
  static async modifierInspection(organisationId, inspectionId, data) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    // CORRECTIF (audit § 8) — même contrôle qu'à la création : on ne peut pas
    // réaffecter l'inspection à un utilisateur d'une autre organisation.
    if (data.inspecteurId) {
      const erreur = await InspectionService._verifierInspecteur(organisationId, data.inspecteurId);
      if (erreur) return { success: false, message: erreur };
    }

    const updates = {};
    for (const champ of ['inspecteurId', 'type', 'date_visite', 'statut', 'compte_rendu']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }

    await inspection.update(updates);
    return { success: true, message: 'Inspection mise à jour', inspection };
  }

  // -------------------- COCHER UNE LIGNE DE CHECKLIST --------------------
  static async cocherChecklist(organisationId, inspectionId, checklistId, { coche, commentaire }) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const ligne = await Checklist.findOne({ where: { id: checklistId, inspectionId } });
    if (!ligne) return { success: false, message: 'Ligne de checklist introuvable' };

    await ligne.update({ coche, commentaire: commentaire !== undefined ? commentaire : ligne.commentaire });
    return { success: true, message: 'Ligne mise à jour', ligne };
  }

  // -------------------- SUPPRIMER UNE INSPECTION --------------------
  /**
   * CORRECTIF (audit § 4) — le soft delete ne cascade pas.
   *
   * Le commentaire « cascade sur la checklist » était faux : `onDelete: CASCADE`
   * est une contrainte SQL, jamais déclenchée par un `UPDATE deleted_at`. Les
   * lignes de checklist restaient donc actives et orphelines. Checklist est
   * désormais paranoid (cf. checklist.model.js + migration) et supprimée
   * explicitement, dans une transaction.
   */
  static async supprimerInspection(organisationId, inspectionId) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const t = await sequelize.transaction();
    try {
      await Checklist.destroy({ where: { inspectionId }, transaction: t });
      await inspection.destroy({ transaction: t }); // soft delete
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Inspection supprimée' };
  }
}

module.exports = InspectionService;
