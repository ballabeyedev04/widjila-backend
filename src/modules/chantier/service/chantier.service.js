'use strict';

const { Op } = require('sequelize');
const {
  Chantier, Batiment, Etage, Zone, Lot, Reserve, Utilisateur, ChantierMembre,
  Phase, Inspection, Plan, Annotation, Document, Rapport, Checklist,
  Commentaire, PieceJointe,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const NotificationService = require('../../notification/service/notification.service.js');
const escapeLike = require('../../../utils/escapeLike.js');
const { GESTION } = require('../../../config/roles.js');

// Statuts « fin de vie » d'un chantier : aucun ne doit pouvoir être atteint
// tant qu'il reste des réserves ouvertes (cf. changerStatut).
const STATUTS_FERMETURE = ['cloture', 'archive'];

// Statuts de réserve considérés comme soldés.
const RESERVE_SOLDEE = ['validee', 'cloturee'];

class ChantierService {

  // -------------------- CRÉER UN CHANTIER --------------------
  static async creerChantier(organisationId, data) {
    // Vérifier que le responsable appartient bien à l'organisation
    if (data.responsableId) {
      const responsable = await Utilisateur.findOne({
        where: { id: data.responsableId, organisationId },
      });
      if (!responsable) {
        return { success: false, message: 'Le responsable n’appartient pas à cette organisation' };
      }
    }

    // Code auto si absent : CH-XXXX (4 caractères hex)
    const code = data.code || `CH-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

    const chantier = await Chantier.create({
      organisationId,
      code,
      nom: data.nom,
      description: data.description || null,
      adresse: data.adresse || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      date_debut: data.date_debut || null,
      date_fin: data.date_fin || null,
      responsableId: data.responsableId || null,
      budget: data.budget || null,
      // Absent → le modèle applique 'en_preparation'
      ...(data.statut ? { statut: data.statut } : {}),
    });

    return { success: true, message: 'Chantier créé avec succès', chantier };
  }

  // -------------------- LISTER LES CHANTIERS --------------------
  static async listChantiers(organisationId, { page = 1, limit = 20, search = '', statut } = {}) {
    const where = { organisationId };
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { code: { [Op.iLike]: motif } },
      ];
    }
    if (statut) where.statut = statut;

    const { rows, count } = await Chantier.findAndCountAll({
      where,
      include: [{ model: Utilisateur, as: 'responsable', attributes: ['id', 'nom', 'prenom', 'email', 'photoProfil'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    // Compteurs de réserves par chantier (batch — une requête, pas N+1)
    const chantierIds = rows.map((c) => c.id);
    const compteurs = chantierIds.length
      ? await Reserve.findAll({
          where: { chantierId: chantierIds },
          attributes: ['chantierId', 'statut'],
          raw: true,
        })
      : [];

    const statsMap = {};
    for (const c of compteurs) {
      statsMap[c.chantierId] = statsMap[c.chantierId] || { total: 0, ouvertes: 0, validees: 0 };
      statsMap[c.chantierId].total += 1;
      if (['validee', 'cloturee'].includes(c.statut)) statsMap[c.chantierId].validees += 1;
      else statsMap[c.chantierId].ouvertes += 1;
    }

    const chantiers = rows.map((c) => {
      const cj = c.toJSON();
      cj.statsReserves = statsMap[c.id] || { total: 0, ouvertes: 0, validees: 0 };
      return cj;
    });

    return { success: true, chantiers, total: count };
  }

  // -------------------- DÉTAIL D'UN CHANTIER --------------------
  static async getChantier(chantierId) {
    const chantier = await Chantier.findByPk(chantierId, {
      include: [
        { model: Utilisateur, as: 'responsable', attributes: ['id', 'nom', 'prenom', 'email', 'photoProfil'] },
        {
          model: Batiment,
          as: 'batiments',
          include: [{
            model: Etage,
            as: 'etages',
            include: [{ model: Zone, as: 'zones' }],
          }],
        },
        { model: Lot, as: 'lots' },
      ],
      order: [[{ model: Batiment, as: 'batiments' }, 'nom', 'ASC']],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };
    return { success: true, chantier };
  }

  // -------------------- MODIFIER UN CHANTIER --------------------
  static async modifierChantier(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    if (data.responsableId && data.responsableId !== chantier.responsableId) {
      const responsable = await Utilisateur.findOne({
        where: { id: data.responsableId, organisationId },
      });
      if (!responsable) return { success: false, message: 'Le responsable n’appartient pas à cette organisation' };
    }

    const updates = {};
    for (const champ of ['code', 'nom', 'description', 'adresse', 'latitude', 'longitude', 'date_debut', 'date_fin', 'responsableId', 'budget']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }

    await chantier.update(updates);
    return { success: true, message: 'Chantier mis à jour avec succès', chantier };
  }

  // -------------------- CHANGER LE STATUT --------------------
  static async changerStatut(organisationId, chantierId, statut) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Règle métier : un chantier ne peut pas être clôturé s'il reste des
    // réserves ouvertes (statut différent de validee/cloturee).
    //
    // CORRECTIF (audit § 9) — la garde ne visait que 'cloture'. Or 'archive'
    // ferme tout autant le chantier (il sort des tableaux de bord actifs) :
    // il suffisait donc d'archiver au lieu de clôturer pour solder un chantier
    // avec des réserves non levées, exactement ce que la règle interdit.
    if (STATUTS_FERMETURE.includes(statut)) {
      const ouvertes = await Reserve.count({
        where: {
          chantierId,
          statut: { [Op.notIn]: RESERVE_SOLDEE },
        },
      });
      if (ouvertes > 0) {
        const action = statut === 'archive' ? 'd’archiver' : 'de clôturer';
        return {
          success: false,
          message: `Impossible ${action} le chantier : ${ouvertes} réserve(s) encore ouverte(s).`,
        };
      }
    }

    await chantier.update({ statut });
    return { success: true, message: 'Statut du chantier mis à jour', chantier };
  }

  // -------------------- SUPPRIMER UN CHANTIER --------------------
  /**
   * CORRECTIF (audit § 4) — le soft delete NE CASCADE PAS.
   *
   * L'ancien commentaire « cascade par association » était faux : les
   * `onDelete: CASCADE` déclarés dans models/index.js sont des contraintes
   * référentielles SQL, déclenchées uniquement par un DELETE physique. Un soft
   * delete n'est qu'un `UPDATE chantiers SET deleted_at = now()` : réserves,
   * plans, documents, bâtiments et inspections restaient `deleted_at IS NULL`,
   * donc invisibles via l'API (leur chantier ayant disparu) mais toujours
   * comptés par les agrégats globaux — `statistiques.service.js` fait un
   * `Reserve.count()` sans jointure, qui gonflait indéfiniment.
   *
   * On soft delete donc explicitement toute la descendance paranoid, dans une
   * transaction (tout ou rien : un chantier à moitié supprimé serait pire que
   * pas supprimé du tout).
   */
  static async supprimerChantier(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const t = await sequelize.transaction();
    try {
      await ChantierService._supprimerDescendance(chantierId, t);
      await chantier.destroy({ transaction: t }); // soft delete du chantier
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Chantier supprimé' };
  }

  /**
   * Soft delete de toute la descendance paranoid d'un chantier.
   *
   * Les tables NON paranoid (medias, reserve_positions, reserve_historiques,
   * checklists avant migration, chantier_membres) sont volontairement laissées
   * intactes : elles portent la traçabilité et les fichiers, et un `restore()`
   * du chantier doit les retrouver. Les fichiers sur disque ne sont donc PAS
   * supprimés ici — un soft delete est réversible (cf. audit § 5 : seuls les
   * effacements DÉFINITIFS appellent deleteFile).
   */
  static async _supprimerDescendance(chantierId, transaction) {
    const parChantier = { where: { chantierId }, transaction };

    // ── Réserves et leurs filles ────────────────────────────────────────────
    const reserves = await Reserve.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const reserveIds = reserves.map((r) => r.id);
    if (reserveIds.length) {
      const parReserve = { where: { reserveId: { [Op.in]: reserveIds } }, transaction };
      await Commentaire.destroy(parReserve);
      await PieceJointe.destroy(parReserve);
      await Reserve.destroy(parChantier);
    }

    // ── Plans et leurs annotations ──────────────────────────────────────────
    const plans = await Plan.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const planIds = plans.map((p) => p.id);
    if (planIds.length) {
      await Annotation.destroy({ where: { planId: { [Op.in]: planIds } }, transaction });
      await Plan.destroy(parChantier);
    }

    // ── Inspections et leurs checklists ─────────────────────────────────────
    const inspections = await Inspection.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const inspectionIds = inspections.map((i) => i.id);
    if (inspectionIds.length) {
      await Checklist.destroy({ where: { inspectionId: { [Op.in]: inspectionIds } }, transaction });
      await Inspection.destroy(parChantier);
    }

    // ── Structure : bâtiments → étages → zones ──────────────────────────────
    const batiments = await Batiment.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const batimentIds = batiments.map((b) => b.id);
    if (batimentIds.length) {
      const etages = await Etage.findAll({
        where: { batimentId: { [Op.in]: batimentIds } }, attributes: ['id'], raw: true, transaction,
      });
      const etageIds = etages.map((e) => e.id);
      if (etageIds.length) {
        await Zone.destroy({ where: { etageId: { [Op.in]: etageIds } }, transaction });
        await Etage.destroy({ where: { batimentId: { [Op.in]: batimentIds } }, transaction });
      }
      await Batiment.destroy(parChantier);
    }

    // ── Reste des entités rattachées au chantier ────────────────────────────
    await Lot.destroy(parChantier);
    await Document.destroy(parChantier);
    await Phase.destroy(parChantier);
    await Rapport.destroy(parChantier);
  }

  // -------------------- STRUCTURE (bâtiments / étages / zones) --------------------
  static async creerBatiment(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const batiment = await Batiment.create({
      chantierId,
      nom: data.nom,
      code: data.code || null,
    });
    return { success: true, message: 'Bâtiment créé avec succès', batiment };
  }

  static async creerEtage(organisationId, chantierId, batimentId, data) {
    // Le bâtiment doit appartenir au chantier ET à l'organisation
    const batiment = await Batiment.findOne({
      where: { id: batimentId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!batiment) return { success: false, message: 'Bâtiment introuvable dans ce chantier' };

    const etage = await Etage.create({
      batimentId,
      nom: data.nom,
      niveau: data.niveau ?? 0,
    });
    return { success: true, message: 'Étage créé avec succès', etage };
  }

  static async creerZone(organisationId, chantierId, batimentId, etageId, data) {
    const etage = await Etage.findOne({
      where: { id: etageId, batimentId },
      include: [{
        model: Batiment,
        as: 'batiment',
        where: { chantierId },
        include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      }],
    });
    if (!etage) return { success: false, message: 'Étage introuvable dans ce bâtiment' };

    const zone = await Zone.create({
      etageId,
      nom: data.nom,
      type: data.type || 'zone',
    });
    return { success: true, message: 'Zone créée avec succès', zone };
  }

  // -------------------- LOTS --------------------
  static async creerLot(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const lot = await Lot.create({
      chantierId,
      nom: data.nom,
      code: data.code || null,
      corps_d_etat: data.corps_d_etat || null,
    });
    return { success: true, message: 'Lot créé avec succès', lot };
  }

  static async listLots(organisationId, chantierId) {
    const lots = await Lot.findAll({
      where: { chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
      order: [['nom', 'ASC']],
    });
    return { success: true, lots };
  }

  // -------------------- AFFECTATION DES MEMBRES AU CHANTIER (module 1) --------------------
  /** Affecte un ou plusieurs membres de l'organisation à un chantier. */
  static async assignerMembres(organisationId, chantierId, membreIds, roleChantier = null) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const membres = await Utilisateur.findAll({ where: { id: membreIds, organisationId } });
    if (membres.length !== membreIds.length) {
      return { success: false, message: 'Certains membres ne font pas partie de cette organisation' };
    }

    await chantier.addMembres(membres.map((m) => m.id));

    // Mettre à jour le rôle sur le chantier (si précisé)
    if (roleChantier) {
      await ChantierMembre.update(
        { roleChantier },
        { where: { chantierId, utilisateurId: membreIds } }
      );
    }

    // Notifier les membres affectés (module 8)
    for (const m of membres) {
      await NotificationService.notifier({
        utilisateurId: m.id,
        type: 'chantier.affectation',
        titre: 'Affectation chantier',
        message: `Vous avez été affecté(e) au chantier « ${chantier.nom} »${roleChantier ? ` (${roleChantier})` : ''}.`,
        donnees: { chantierId },
      });
    }

    return { success: true, message: 'Membres affectés au chantier' };
  }

  /** Liste les membres affectés à un chantier. */
  /** L'email des intervenants n'est exposé qu'aux rôles de gestion. */
  static async listMembresChantier(organisationId, chantierId, role = null) {
    const peutVoirEmails = role === 'Admin' || GESTION.includes(role);
    const attributs = peutVoirEmails
      ? ['id', 'nom', 'prenom', 'email', 'role', 'photoProfil']
      : ['id', 'nom', 'prenom', 'role', 'photoProfil'];

    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [{
        model: Utilisateur,
        as: 'membres',
        attributes: attributs,
        through: { attributes: ['roleChantier'] },
      }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };
    return { success: true, membres: chantier.membres };
  }

  /** Retire un membre d'un chantier. */
  static async retirerMembreChantier(organisationId, chantierId, membreId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    await chantier.removeMembres(membreId);
    return { success: true, message: 'Membre retiré du chantier' };
  }

  /** Projets d'un utilisateur (affectations) — accessible via /account/chantiers. */
  static async listChantiersUtilisateur(utilisateurId, organisationId) {
    const chantiers = await Chantier.findAll({
      where: { organisationId },
      include: [{
        model: Utilisateur,
        as: 'membres',
        where: { id: utilisateurId },
        required: true,
        attributes: [],
        through: { attributes: ['roleChantier'] },
      }],
      order: [['createdAt', 'DESC']],
    });
    return { success: true, chantiers };
  }

  // -------------------- DUPLICATION D'UN CHANTIER (module 3) --------------------
  /**
   * Copie le chantier et toute sa décomposition (bâtiments → étages → zones,
   * lots). Les réserves, plans et documents ne sont PAS dupliqués
   * (chaque réserve est liée à une position et une version de plan).
   */
  static async dupliquerChantier(organisationId, chantierId, { nom = null } = {}) {
    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [
        {
          model: Batiment, as: 'batiments',
          include: [{ model: Etage, as: 'etages', include: [{ model: Zone, as: 'zones' }] }],
        },
        { model: Lot, as: 'lots' },
      ],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // CORRECTIF (audit § 2) — duplication atomique.
    // Sans transaction, un échec au 3ᵉ bâtiment (contrainte, coupure DB…)
    // laissait un chantier à moitié construit : l'appelant recevait une 500 et
    // pouvait relancer, créant un second squelette incomplet. La copie est
    // désormais tout ou rien.
    const t = await sequelize.transaction();
    let nouveauChantier;
    try {
      nouveauChantier = await Chantier.create({
        organisationId,
        code: `CH-${Math.random().toString(16).slice(2, 6).toUpperCase()}`,
        nom: nom || `${chantier.nom} (copie)`,
        description: chantier.description,
        adresse: chantier.adresse,
        latitude: chantier.latitude,
        longitude: chantier.longitude,
        date_debut: chantier.date_debut,
        date_fin: chantier.date_fin,
        responsableId: chantier.responsableId,
        budget: chantier.budget,
        statut: 'en_preparation',
      }, { transaction: t });

      // Bâtiments → étages → zones
      for (const batiment of chantier.batiments || []) {
        const newBat = await Batiment.create(
          { chantierId: nouveauChantier.id, nom: batiment.nom, code: batiment.code },
          { transaction: t }
        );
        for (const etage of batiment.etages || []) {
          const newEtage = await Etage.create(
            { batimentId: newBat.id, nom: etage.nom, niveau: etage.niveau },
            { transaction: t }
          );
          for (const zone of etage.zones || []) {
            await Zone.create(
              { etageId: newEtage.id, nom: zone.nom, type: zone.type },
              { transaction: t }
            );
          }
        }
      }

      // Lots
      for (const lot of chantier.lots || []) {
        await Lot.create({
          chantierId: nouveauChantier.id,
          nom: lot.nom, code: lot.code, corps_d_etat: lot.corps_d_etat,
        }, { transaction: t });
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Chantier dupliqué avec succès', chantier: nouveauChantier };
  }

  // -------------------- PHASES & PLANNING (module 3) --------------------
  static async creerPhase(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const phase = await Phase.create({
      chantierId,
      nom: data.nom,
      description: data.description || null,
      ordre: data.ordre || 0,
      date_debut: data.date_debut || null,
      date_fin: data.date_fin || null,
      statut: data.statut || 'planifiee',
    });
    return { success: true, message: 'Phase créée avec succès', phase };
  }

  static async listPhases(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const phases = await Phase.findAll({ where: { chantierId }, order: [['ordre', 'ASC']] });
    return { success: true, phases };
  }

  static async modifierPhase(organisationId, chantierId, phaseId, data) {
    const phase = await Phase.findOne({
      where: { id: phaseId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
    });
    if (!phase) return { success: false, message: 'Phase introuvable' };

    const updates = {};
    for (const champ of ['nom', 'description', 'ordre', 'date_debut', 'date_fin', 'statut']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    await phase.update(updates);
    return { success: true, message: 'Phase mise à jour', phase };
  }

  static async supprimerPhase(organisationId, chantierId, phaseId) {
    const phase = await Phase.findOne({
      where: { id: phaseId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
    });
    if (!phase) return { success: false, message: 'Phase introuvable' };

    await phase.destroy(); // soft delete
    return { success: true, message: 'Phase supprimée' };
  }

  // -------------------- CALENDRIER / PLANNING (module 3) --------------------
  /**
   * Agrège les phases, inspections et échéances de réserves du chantier
   * sous forme d'événements de calendrier.
   */
  static async calendrier(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const [phases, inspections, reserves] = await Promise.all([
      Phase.findAll({ where: { chantierId }, order: [['ordre', 'ASC']] }),
      Inspection.findAll({ where: { chantierId }, attributes: ['id', 'type', 'date_visite', 'statut'] }),
      Reserve.findAll({ where: { chantierId }, attributes: ['id', 'numero', 'titre', 'date_limite', 'statut'] }),
    ]);

    const evenements = [];
    for (const p of phases) {
      evenements.push({
        type: 'phase', id: p.id, titre: p.nom,
        dateDebut: p.date_debut, dateFin: p.date_fin, statut: p.statut,
      });
    }
    for (const i of inspections) {
      if (i.date_visite) {
        evenements.push({
          type: 'inspection', id: i.id,
          titre: `Inspection ${i.type.replace(/_/g, ' ')}`,
          dateDebut: i.date_visite, dateFin: i.date_visite, statut: i.statut,
        });
      }
    }
    for (const r of reserves) {
      if (r.date_limite) {
        evenements.push({
          type: 'reserve', id: r.id,
          titre: `${r.numero} — ${r.titre}`,
          dateDebut: r.date_limite, dateFin: r.date_limite, statut: r.statut,
        });
      }
    }

    evenements.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));

    return { success: true, calendrier: { evenements, phases, inspections } };
  }
}

module.exports = ChantierService;
