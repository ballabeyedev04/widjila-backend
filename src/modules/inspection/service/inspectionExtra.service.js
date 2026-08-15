'use strict';

const { ChecklistModele, Convocation, Inspection, Chantier, Utilisateur, Checklist } = require('../../../models/index.js');
const NotificationService = require('../../notification/service/notification.service.js');

/**
 * Inspections — extensions module 6 : modèles de checklist réutilisables et
 * convocations / présence aux inspections (OPR, visites contradictoires…).
 */
class InspectionExtraService {

  // -------------------- VÉRIFICATION D'ACCÈS --------------------
  static async _verifierInspection(organisationId, inspectionId) {
    const inspection = await Inspection.findByPk(inspectionId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    return inspection && inspection.chantier ? inspection : null;
  }

  // -------------------- MODÈLES DE CHECKLIST (CRUD) --------------------
  static async creerModele(organisationId, { nom, description, items }, utilisateurId) {
    if (!nom || !nom.trim()) return { success: false, message: 'Nom du modèle requis' };
    const modele = await ChecklistModele.create({
      organisationId,
      nom: nom.trim(),
      description: description || null,
      items: Array.isArray(items) ? items : [],
      creePar: utilisateurId,
    });
    return { success: true, message: 'Modèle de checklist créé', modele };
  }

  static async listModeles(organisationId) {
    const modeles = await ChecklistModele.findAll({
      where: { organisationId },
      order: [['nom', 'ASC']],
    });
    return { success: true, modeles };
  }

  static async modifierModele(organisationId, modeleId, data) {
    const modele = await ChecklistModele.findOne({ where: { id: modeleId, organisationId } });
    if (!modele) return { success: false, message: 'Modèle introuvable' };

    if (data.nom !== undefined) modele.nom = data.nom.trim();
    if (data.description !== undefined) modele.description = data.description;
    if (data.items !== undefined) modele.items = Array.isArray(data.items) ? data.items : [];
    await modele.save();
    return { success: true, message: 'Modèle mis à jour', modele };
  }

  static async supprimerModele(organisationId, modeleId) {
    const modele = await ChecklistModele.findOne({ where: { id: modeleId, organisationId } });
    if (!modele) return { success: false, message: 'Modèle introuvable' };
    await modele.destroy(); // soft delete
    return { success: true, message: 'Modèle supprimé' };
  }

  // -------------------- CONVOCATIONS --------------------
  /** Convocation d'un utilisateur à une inspection (statut initial : invité). */
  static async convier(organisationId, inspectionId, utilisateurId) {
    const inspection = await InspectionExtraService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const u = await Utilisateur.findOne({ where: { id: utilisateurId, organisationId } });
    if (!u) return { success: false, message: 'Utilisateur non rattaché à votre organisation' };

    const [convocation, cree] = await Convocation.findOrCreate({
      where: { inspectionId, utilisateurId },
      defaults: { inspectionId, utilisateurId, statut: 'invite' },
    });

    if (cree) {
      await NotificationService.notifier({
        utilisateurId,
        type: 'inspection.convocation',
        titre: 'Convocation',
        message: `Vous êtes convié(e) à l'inspection ${inspection.type} du ${inspection.date_visite || 'à définir'}.`,
        donnees: { inspectionId },
      });
    }

    return { success: true, message: cree ? 'Utilisateur convié' : 'Déjà convié', convocation };
  }

  static async listConvocations(organisationId, inspectionId) {
    const inspection = await InspectionExtraService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const convocations = await Convocation.findAll({
      where: { inspectionId },
      include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'photoProfil', 'email'] }],
      order: [['createdAt', 'ASC']],
    });
    return { success: true, convocations };
  }

  /**
   * Réponse / pointage de présence d'un convoqué.
   * Statuts possibles : invite → accepte / decline → present / absent.
   * @param {string} role — rôle de l'appelant (seul Admin/ChefProjet pointe la présence d'autrui)
   */
  static async repondreConvocation(organisationId, inspectionId, convocationId, { statut }, utilisateurId, role) {
    const inspection = await InspectionExtraService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const convocation = await Convocation.findOne({ where: { id: convocationId, inspectionId } });
    if (!convocation) return { success: false, message: 'Convocation introuvable' };

    // Un utilisateur ne peut répondre que pour lui-même (sauf Admin/ChefProjet)
    if (convocation.utilisateurId !== utilisateurId && !['Admin', 'ChefProjet'].includes(role)) {
      return { success: false, message: 'Impossible de répondre pour un autre intervenant' };
    }

    const statutsValides = ['accepte', 'decline', 'present', 'absent'];
    if (!statutsValides.includes(statut)) {
      return { success: false, message: `Statut invalide (attendu : ${statutsValides.join(', ')})` };
    }

    await convocation.update({ statut, repondu_le: new Date() });
    return { success: true, message: 'Réponse enregistrée', convocation };
  }

  static async retirerConvocation(organisationId, inspectionId, convocationId) {
    const inspection = await InspectionExtraService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const convocation = await Convocation.findOne({ where: { id: convocationId, inspectionId } });
    if (!convocation) return { success: false, message: 'Convocation introuvable' };
    await convocation.destroy();
    return { success: true, message: 'Convocation retirée' };
  }

  // -------------------- APPLICATION D'UN MODÈLE À UNE INSPECTION --------------------
  /** Préremplit la checklist d'une inspection depuis un modèle. */
  static async appliquerModele(organisationId, inspectionId, modeleId) {
    const inspection = await InspectionExtraService._verifierInspection(organisationId, inspectionId);
    if (!inspection) return { success: false, message: 'Inspection introuvable dans cette organisation' };

    const modele = await ChecklistModele.findOne({ where: { id: modeleId, organisationId } });
    if (!modele) return { success: false, message: 'Modèle introuvable' };
    if (!Array.isArray(modele.items) || !modele.items.length) {
      return { success: false, message: 'Le modèle ne contient aucun item' };
    }

    const lignes = modele.items.map((item) => ({
      inspectionId,
      libelle: (typeof item === 'string' ? item : item.libelle) || 'Sans libellé',
      coche: false,
      commentaire: null,
    }));
    await Checklist.bulkCreate(lignes);
    return { success: true, message: `${lignes.length} ligne(s) ajoutée(s) depuis le modèle` };
  }
}

module.exports = InspectionExtraService;
