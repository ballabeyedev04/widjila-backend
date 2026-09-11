'use strict';

const { Rapport, Chantier } = require('../../../models/index.js');
const R = require('./rapportReferentiel.js');
const donnees = require('./rapportDonnees.service.js');
const RapportsService = require('./rapports.service.js');

/**
 * L'ANCIEN point d'entrée des rapports — `POST /chantiers/:id/rapports/generer`.
 *
 * ── Pourquoi il reste ──────────────────────────────────────────────────────
 *
 * L'espace web et les versions du mobile déjà installées sur les téléphones
 * du chantier l'appellent. Le supprimer en même temps que le nouveau service
 * arrive casserait la génération chez tous les utilisateurs qui n'ont pas
 * encore mis à jour — c'est-à-dire, le jour de la livraison, presque tous.
 *
 * ── Ce qu'il est devenu ────────────────────────────────────────────────────
 *
 * Un simple ADAPTATEUR : il traduit l'ancien « type » vers un modèle du
 * cahier des charges (§ 5), crée la configuration, puis la fait générer par
 * le service Rapports. Les anciens clients reçoivent donc le NOUVEAU document
 * — couverture, synthèse, fiches, plan et pastille — sans rien changer de
 * leur côté.
 */

class RapportService {

  /**
   * Génère un rapport à partir des paramètres de l'ancien écran.
   *
   * @param {object} params — { chantierId, type, statut, entrepriseId,
   *   partenaireId, batimentId, phaseId, corpsEtatId, inspectionId }
   * @param {string} generePar — id de l'utilisateur générateur
   * @param {string} organisationId — isolation multi-tenant
   */
  static async genererRapport(params, generePar, organisationId) {
    const { chantierId, type = 'reserves' } = params;

    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const filtres = {
      statutsReserve: params.statut ? [params.statut] : [],
      entreprises: params.partenaireId ? [params.partenaireId] : [],
      organisationsEntreprise: params.entrepriseId ? [params.entrepriseId] : [],
      batiments: params.batimentId ? [params.batimentId] : [],
      phases: params.phaseId ? [params.phaseId] : [],
      corpsEtat: params.corpsEtatId ? [params.corpsEtatId] : [],
    };

    // L'ancien écran laissait générer « par bâtiment » sans choisir de
    // bâtiment (« Tous »). Le nouveau modèle l'exige ; plutôt que de refuser
    // une demande que l'ancien client considère valide, on retombe sur le
    // modèle global — c'est exactement le périmètre qu'il obtenait avant.
    let modeleId = R.TYPE_LEGACY_VERS_MODELE[type] || 'GLOBAL';
    const canoniques = donnees.normaliserFiltres(filtres);
    const manquants = RapportsService._interne.verifierFiltresRequis(R.MODELES[modeleId], canoniques);
    if (manquants.length) modeleId = 'GLOBAL';

    const creation = await RapportsService.creer({
      chantierId,
      modele: modeleId,
      filtres,
      formats: ['PDF'],
    }, generePar ? { id: generePar } : null, organisationId);
    if (!creation.success) return creation;

    // Le type d'ORIGINE est conservé : c'est lui que l'ancien écran affiche
    // en libellé de ligne.
    await creation.rapport.update({ type, parametres: params });

    const generation = await RapportsService.generer(creation.rapport.id, generePar ? { id: generePar } : null, organisationId);
    if (!generation.success) return generation;

    return { success: true, message: 'Rapport généré avec succès', rapport: generation.rapport };
  }

  // -------------------- LISTER LES RAPPORTS D'UN CHANTIER --------------------
  static async listRapports(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const rapports = await Rapport.findAll({
      where: { chantierId },
      order: [['createdAt', 'DESC']],
    });
    return { success: true, rapports };
  }

  // -------------------- DÉTAIL D'UN RAPPORT --------------------
  static async getRapport(rapportId, organisationId) {
    const rapport = await Rapport.findByPk(rapportId, {
      include: [
        // Scoping multi-tenant : le chantier doit appartenir à l'organisation
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom'] },
      ],
    });
    if (!rapport || !rapport.chantier) {
      return { success: false, message: 'Rapport introuvable dans cette organisation' };
    }
    return { success: true, rapport };
  }

  // -------------------- SUPPRIMER UN RAPPORT --------------------
  static async supprimerRapport(organisationId, rapportId) {
    const rapport = await Rapport.findByPk(rapportId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    await rapport.destroy(); // soft delete
    return { success: true, message: 'Rapport supprimé' };
  }
}

module.exports = RapportService;
