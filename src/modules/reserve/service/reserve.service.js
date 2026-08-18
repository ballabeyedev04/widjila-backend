'use strict';

const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const {
  Reserve, ReservePosition, ReserveHistorique, Commentaire, Media,
  Chantier, Batiment, Etage, Zone, Lot, Plan, Organisation, Utilisateur,
  PieceJointe, ReserveAffectation, Signature,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const NotificationService = require('../../notification/service/notification.service.js');
const escapeLike = require('../../../utils/escapeLike.js');
const { PILOTAGE } = require('../../../config/roles.js');

// ─── Transitions relevant du contrôle qualité ─────────────────────────────────
// Le cahier des charges (tableau RBAC) réserve « Valider une réserve » à
// l'administrateur et au chef de projet — et l'exclut explicitement à
// l'entreprise. Une entreprise doit pouvoir déclarer une correction
// (`corrigee`, `a_verifier`) mais jamais prononcer elle-même le verdict sur
// la réserve qui lui est reprochée.
//
// CORRECTIF (audit § 9) — `rouverte` rejoint les statuts de contrôle.
// Cause : la matrice autorise `validee → rouverte`. Sans cette garde, une
// Entreprise pouvait annuler le verdict du maître d'ouvrage en rouvrant
// elle-même la réserve validée, puis la faire re-valider — contournement
// complet du cloisonnement ci-dessus. La réouverture est un acte de contrôle
// (elle conteste une décision), pas un acte d'exécution : les actes légitimes
// de l'entreprise restent `en_cours`, `corrigee` et `a_verifier`.
const STATUTS_CONTROLE = ['validee', 'refusee', 'cloturee', 'rouverte'];

// ─── Matrice des transitions de statut autorisées ──────────────────────────────
// Cycle de vie (cahier des charges, module 5) :
// creee → affectee → en_cours → corrigee → a_verifier → validee / refusee
//       → (rouverte) → cloturee
const TRANSITIONS = {
  creee:      ['affectee', 'en_cours', 'rouverte'],
  affectee:   ['en_cours', 'corrigee', 'rouverte'],
  en_cours:   ['corrigee', 'a_verifier', 'rouverte'],
  corrigee:   ['a_verifier', 'validee', 'refusee', 'rouverte'],
  a_verifier: ['validee', 'refusee', 'en_cours', 'rouverte'],
  validee:    ['cloturee', 'rouverte'],
  refusee:    ['en_cours', 'corrigee', 'rouverte'],
  rouverte:   ['affectee', 'en_cours', 'corrigee', 'a_verifier'],
  // Positionné automatiquement par le job (module 5) ; reprise du cycle normal
  en_retard:  ['affectee', 'en_cours', 'corrigee', 'a_verifier', 'validee', 'refusee', 'rouverte'],
  cloturee:   [],
};

// Statuts figés : la réserve a reçu son verdict, elle n'est plus modifiable
// (aligné sur la règle déjà appliquée par supprimerReserve).
const STATUTS_FIGES = ['validee', 'cloturee'];

// ══════════════════════════════════════════════════════════════════════════════
//  NUMÉROTATION R-0001 — concurrence & lignes supprimées
//
//  Deux défauts corrigés ici (audit § 1) :
//
//  1. `Reserve` est paranoid : un `findAll` Sequelize EXCLUT les lignes
//     soft-deleted, alors que l'index unique `reserves_chantier_numero_unique`
//     les INCLUT (Postgres indexe toutes les lignes, `deleted_at` ne les retire
//     pas de l'index). Supprimer la réserve de numéro le plus haut faisait donc
//     retomber le calcul dessus → violation d'unicité DÉFINITIVE sur ce
//     chantier. Le calcul se fait désormais en SQL brut, qui ignore le scope
//     paranoid et voit exactement ce que voit l'index.
//
//  2. Lecture-puis-écriture sans verrou : deux créations simultanées lisaient
//     le même MAX et tentaient le même numéro.
//
//  Solution retenue : verrou consultatif Postgres (`pg_advisory_xact_lock`)
//  porté par la transaction, + réessai sur violation d'unicité.
//  Pourquoi ce choix :
//    - une SÉQUENCE dédiée par chantier est ingérable (une séquence à créer /
//      supprimer par chantier) et laisse des trous ;
//    - un `SELECT … FOR UPDATE` ne verrouille que des lignes EXISTANTES : il ne
//      protège pas contre deux INSERT concurrents du premier numéro ;
//    - le verrou consultatif est pris sur une clé logique (`chantier:numero`),
//      il sérialise exactement la section critique, et il est relâché
//      automatiquement au COMMIT/ROLLBACK (aucun risque de verrou orphelin) ;
//    - le réessai reste en filet pour les écritures qui n'auraient pas pris le
//      verrou (ancien process en cours de déploiement, script d'import).
//
//  Performance : le MAX est calculé par UNE agrégation SQL indexée sur
//  chantier_id, plus le chargement de toutes les réserves du chantier
//  (l'ancien code était en O(n) par création, donc O(n²) sur un import).
// ══════════════════════════════════════════════════════════════════════════════

/** Sérialise la numérotation d'un chantier pour la durée de la transaction. */
async function _verrouillerNumerotation(chantierId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle)) AS verrou', {
    replacements: { cle: `reserve:numero:${chantierId}` },
    type: QueryTypes.SELECT,
    transaction,
  });
}

/** Vrai si l'erreur est une collision sur le numéro de réserve. */
function _estCollisionNumero(err) {
  if (!(err instanceof UniqueConstraintError)) return false;
  const contrainte = (err.parent && err.parent.constraint) || '';
  const champs = Object.keys(err.fields || {}).join(',');
  return `${contrainte} ${champs}`.includes('numero');
}

/** Rejoue l'opération si un numéro a été pris entre-temps (filet anti-course). */
async function _avecReessaiNumero(operation, tentatives = 3) {
  for (let essai = 1; ; essai += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!_estCollisionNumero(err) || essai >= tentatives) throw err;
      logger.warn(`[reserve] Collision de numéro détectée — réessai ${essai}/${tentatives - 1}`);
    }
  }
}

class ReserveService {

  // -------------------- NUMÉRO AUTO (R-0001) --------------------
  /**
   * Réserve `quantite` numéros consécutifs pour le chantier.
   * DOIT être appelé dans une transaction : le verrou consultatif y est porté.
   * Le SQL brut est volontaire — il ignore le scope paranoid de Sequelize et
   * compte donc AUSSI les réserves supprimées, comme l'index unique.
   */
  static async _prochainsNumeros(chantierId, quantite = 1, transaction) {
    await _verrouillerNumerotation(chantierId, transaction);

    const [ligne] = await sequelize.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '[^0-9]', '', 'g'), '')::bigint), 0) AS max
         FROM reserves
        WHERE chantier_id = :chantierId`,
      { replacements: { chantierId }, type: QueryTypes.SELECT, transaction }
    );

    const max = Number(ligne && ligne.max) || 0;
    return Array.from({ length: quantite }, (_, i) => `R-${String(max + 1 + i).padStart(4, '0')}`);
  }

  /** Raccourci — un seul numéro. */
  static async _prochainNumero(chantierId, transaction) {
    const [numero] = await ReserveService._prochainsNumeros(chantierId, 1, transaction);
    return numero;
  }

  // -------------------- VÉRIFICATION DE COHÉRENCE DE LOCALISATION --------------------
  /**
   * Contrôle que les éléments de localisation (bâtiment, étage, zone, plan,
   * lot) appartiennent bien au chantier de la réserve.
   */
  static async _verifierLocalisation(chantierId, { batimentId, etageId, zoneId, planId, lotId }) {
    if (batimentId) {
      const b = await Batiment.findOne({ where: { id: batimentId, chantierId } });
      if (!b) return 'Bâtiment non rattaché à ce chantier';
    }
    if (etageId) {
      const e = await Etage.findOne({
        where: { id: etageId },
        include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: [] }],
      });
      if (!e) return 'Étage non rattaché à ce chantier';
    }
    if (zoneId) {
      const z = await Zone.findOne({
        where: { id: zoneId },
        include: [{ model: Etage, as: 'etage', include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: [] }] }],
      });
      if (!z) return 'Zone non rattachée à ce chantier';
    }
    if (planId) {
      const p = await Plan.findOne({ where: { id: planId, chantierId } });
      if (!p) return 'Plan non rattaché à ce chantier';
    }
    if (lotId) {
      const l = await Lot.findOne({ where: { id: lotId, chantierId } });
      if (!l) return 'Lot non rattaché à ce chantier';
    }
    return null;
  }

  /** Vérifie qu'une entreprise est rattachée à l'organisation (même org, filiale ou agence). */
  static async _verifierEntreprise(organisationId, entrepriseId) {
    const entreprise = await Organisation.findByPk(entrepriseId);
    if (!entreprise) return 'Entreprise introuvable';

    const memeOrg = String(entreprise.id) === String(organisationId);
    const filiale = String(entreprise.parent_id) === String(organisationId);
    // Agence : sa filiale doit être une filiale de l'organisation
    let agence = false;
    if (!memeOrg && !filiale && entreprise.parent_id) {
      const parent = await Organisation.findByPk(entreprise.parent_id);
      agence = parent && String(parent.parent_id) === String(organisationId);
    }
    if (!memeOrg && !filiale && !agence) {
      return 'Entreprise non rattachée à votre organisation';
    }
    return null;
  }

  /**
   * CORRECTIF (audit § 8) — référence inter-tenant non validée.
   * `entrepriseId` était contrôlé mais jamais `assigneA` : on pouvait affecter
   * une réserve à l'utilisateur d'une AUTRE organisation, qui recevait alors
   * une notification divulguant le nom du chantier et le titre de la réserve.
   */
  static async _verifierAssigne(organisationId, assigneA) {
    const utilisateur = await Utilisateur.findOne({ where: { id: assigneA, organisationId } });
    if (!utilisateur) return 'Utilisateur assigné non rattaché à votre organisation';
    return null;
  }

  /** Contrôles communs à creerReserve / creerReserveSerie (lectures seules). */
  static async _verifierReferences(organisationId, data) {
    if (data.entrepriseId) {
      const erreur = await ReserveService._verifierEntreprise(organisationId, data.entrepriseId);
      if (erreur) return erreur;
    }
    if (data.assigneA) {
      const erreur = await ReserveService._verifierAssigne(organisationId, data.assigneA);
      if (erreur) return erreur;
    }
    return null;
  }

  // -------------------- CRÉER UNE RÉSERVE --------------------
  static async creerReserve(organisationId, data, utilisateurId) {
    const chantier = await Chantier.findOne({ where: { id: data.chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const erreurRef = await ReserveService._verifierReferences(organisationId, data);
    if (erreurRef) return { success: false, message: erreurRef };

    const erreurLoc = await ReserveService._verifierLocalisation(data.chantierId, data);
    if (erreurLoc) return { success: false, message: erreurLoc };

    // CORRECTIF (audit § 2) — atomicité. Réserve + position + historique
    // formaient trois écritures indépendantes : un échec sur la 2ᵉ laissait une
    // réserve sans position ni trace d'historique, en violation de la règle
    // « toute modification est historisée ».
    const reserve = await _avecReessaiNumero(async () => {
      const t = await sequelize.transaction();
      try {
        const numero = await ReserveService._prochainNumero(data.chantierId, t);

        const creee = await Reserve.create({
          numero,
          chantierId: data.chantierId,
          batimentId: data.batimentId || null,
          etageId: data.etageId || null,
          zoneId: data.zoneId || null,
          planId: data.planId || null,
          lotId: data.lotId || null,
          titre: data.titre,
          description: data.description || null,
          severite: data.severite || 'moyenne',
          priorite: data.priorite || 'moyenne',
          categorie: data.categorie || 'autre',
          entrepriseId: data.entrepriseId || null,
          assigneA: data.assigneA || null,
          date_limite: data.date_limite || null,
          creePar: utilisateurId,
        }, { transaction: t });

        // Position sur le plan (facultatif)
        if (data.position) {
          await ReservePosition.create({
            reserveId: creee.id,
            x: data.position.x,
            y: data.position.y,
            zoom: data.position.zoom ?? 1,
          }, { transaction: t });
        }

        // Historique — traçabilité de la création
        await ReserveHistorique.create({
          reserveId: creee.id,
          utilisateurId,
          action: 'creation',
          nouvelles_valeurs: { titre: creee.titre, statut: creee.statut },
        }, { transaction: t });

        await t.commit();
        return creee;
      } catch (err) {
        await t.rollback();
        throw err;
      }
    });

    // Notification métier (module 8) : HORS transaction, best-effort — une
    // notification en échec ne doit jamais annuler la création de la réserve.
    if (reserve.assigneA) {
      await NotificationService.notifier({
        utilisateurId: reserve.assigneA,
        type: 'reserve.affectee',
        titre: 'Réserve affectée',
        message: `La réserve ${reserve.numero} « ${reserve.titre} » vous a été affectée sur ${chantier.nom}.`,
        donnees: { reserveId: reserve.id, chantierId: chantier.id },
      });
    }

    return { success: true, message: 'Réserve créée avec succès', reserve };
  }

  // -------------------- CRÉER DES RÉSERVES EN SÉRIE (module 5) --------------------
  /**
   * Crée plusieurs réserves d'un coup (série de réserves de chantier).
   *
   * CORRECTIF (audit § 3) — la version en série ne vérifiait pas l'entreprise,
   * n'écrivait AUCUN ReserveHistorique (règle « toute modification est
   * historisée » violée), ignorait `position` pourtant accepté par le schéma
   * Joi, et ne notifiait personne. Elle est désormais alignée sur creerReserve.
   */
  static async creerReserveSerie(organisationId, data, utilisateurId) {
    const chantier = await Chantier.findOne({ where: { id: data.chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // CORRECTIF (audit § 3 / § 8) — contrôles absents de la version en série
    const erreurRef = await ReserveService._verifierReferences(organisationId, data);
    if (erreurRef) return { success: false, message: erreurRef };

    // Titres explicites OU titre de base + nombre (suffixe 1..n)
    let titres = [];
    if (Array.isArray(data.titres) && data.titres.length) {
      titres = data.titres.slice(0, 100).map((t) => String(t).trim());
    } else {
      const nb = Math.min(Math.max(parseInt(data.nombre, 10) || 1, 1), 100);
      for (let i = 0; i < nb; i += 1) {
        titres.push(nb > 1 ? `${data.titre} ${i + 1}` : data.titre);
      }
    }

    const erreurLoc = await ReserveService._verifierLocalisation(data.chantierId, data);
    if (erreurLoc) return { success: false, message: erreurLoc };

    // CORRECTIF (audit § 1 / § 2) — un seul calcul de numéros pour toute la
    // série (l'ancien code rechargeait TOUTES les réserves du chantier à chaque
    // itération : O(n²) sur un import de 500 lignes), et un import est
    // désormais tout-ou-rien.
    const reserves = await _avecReessaiNumero(async () => {
      const t = await sequelize.transaction();
      try {
        const numeros = await ReserveService._prochainsNumeros(data.chantierId, titres.length, t);

        const creees = await Reserve.bulkCreate(
          titres.map((titre, i) => ({
            numero: numeros[i],
            chantierId: data.chantierId,
            batimentId: data.batimentId || null,
            etageId: data.etageId || null,
            zoneId: data.zoneId || null,
            planId: data.planId || null,
            lotId: data.lotId || null,
            titre,
            description: data.description || null,
            severite: data.severite || 'moyenne',
            priorite: data.priorite || 'moyenne',
            categorie: data.categorie || 'autre',
            entrepriseId: data.entrepriseId || null,
            assigneA: data.assigneA || null,
            date_limite: data.date_limite || null,
            creePar: utilisateurId,
          })),
          { transaction: t, validate: true }
        );

        // Position sur le plan — le schéma Joi l'accepte, elle était ignorée
        if (data.position) {
          await ReservePosition.bulkCreate(
            creees.map((r) => ({
              reserveId: r.id,
              x: data.position.x,
              y: data.position.y,
              zoom: data.position.zoom ?? 1,
            })),
            { transaction: t }
          );
        }

        // Historique — obligatoire pour chaque réserve créée
        await ReserveHistorique.bulkCreate(
          creees.map((r) => ({
            reserveId: r.id,
            utilisateurId,
            action: 'creation',
            nouvelles_valeurs: { titre: r.titre, statut: r.statut, serie: true },
          })),
          { transaction: t }
        );

        await t.commit();
        return creees;
      } catch (err) {
        await t.rollback();
        throw err;
      }
    });

    // Notification unique (hors transaction, best-effort) : une série de 100
    // réserves ne doit pas produire 100 notifications à la même personne.
    if (data.assigneA && reserves.length) {
      await NotificationService.notifier({
        utilisateurId: data.assigneA,
        type: 'reserve.affectee',
        titre: 'Réserves affectées',
        message: `${reserves.length} réserve(s) (${reserves[0].numero} → ${reserves[reserves.length - 1].numero}) vous ont été affectées sur ${chantier.nom}.`,
        donnees: { chantierId: chantier.id, total: reserves.length },
      });
    }

    return {
      success: true,
      message: `${reserves.length} réserve(s) créée(s) avec succès`,
      reserves,
    };
  }

  // -------------------- DUPLIQUER UNE RÉSERVE (module 5) --------------------
  /** Crée une copie de la réserve (nouveau numéro, sans médias ni historique). */
  static async dupliquerReserve(organisationId, reserveId, utilisateurId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const position = await ReservePosition.findOne({ where: { reserveId } });

    // CORRECTIF (audit § 1 / § 2) — numérotation verrouillée + copie atomique
    const copie = await _avecReessaiNumero(async () => {
      const t = await sequelize.transaction();
      try {
        const numero = await ReserveService._prochainNumero(reserve.chantierId, t);
        const nouvelle = await Reserve.create({
          numero,
          chantierId: reserve.chantierId,
          batimentId: reserve.batimentId,
          etageId: reserve.etageId,
          zoneId: reserve.zoneId,
          planId: reserve.planId,
          lotId: reserve.lotId,
          titre: `${reserve.titre} (copie)`,
          description: reserve.description,
          severite: reserve.severite,
          priorite: reserve.priorite,
          categorie: reserve.categorie,
          entrepriseId: reserve.entrepriseId,
          assigneA: reserve.assigneA,
          date_limite: reserve.date_limite,
          creePar: utilisateurId,
          statut: 'creee',
        }, { transaction: t });

        // Copie de la position (si définie)
        if (position) {
          await ReservePosition.create({
            reserveId: nouvelle.id,
            x: position.x,
            y: position.y,
            zoom: position.zoom ?? 1,
          }, { transaction: t });
        }

        // Historique — la copie est une création à part entière
        await ReserveHistorique.create({
          reserveId: nouvelle.id,
          utilisateurId,
          action: 'creation',
          nouvelles_valeurs: { titre: nouvelle.titre, statut: nouvelle.statut, duplicateDe: reserve.id },
        }, { transaction: t });

        await t.commit();
        return nouvelle;
      } catch (err) {
        await t.rollback();
        throw err;
      }
    });

    return { success: true, message: 'Réserve dupliquée avec succès', reserve: copie };
  }

  // -------------------- LISTER LES RÉSERVES --------------------
  static async listReserves(organisationId, chantierId, {
    page = 1, limit = 20, statut, severite, priorite, lotId, entrepriseId, assigneA, search,
  } = {}) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const where = { chantierId };
    if (statut) where.statut = statut;
    if (severite) where.severite = severite;
    if (priorite) where.priorite = priorite;
    if (lotId) where.lotId = lotId;
    if (entrepriseId) where.entrepriseId = entrepriseId;
    if (assigneA) where.assigneA = assigneA;
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { titre: { [Op.iLike]: motif } },
        { description: { [Op.iLike]: motif } },
        { numero: { [Op.iLike]: motif } },
      ];
    }

    const { rows, count } = await Reserve.findAndCountAll({
      where,
      include: [
        { model: ReservePosition, as: 'position' },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
        // Vignette de la liste (mobile/web) : seulement le premier média,
        // pas la galerie complète (réservée au détail). `separate: true`
        // est nécessaire dès qu'un `include` hasMany porte son propre
        // `limit` — sinon Sequelize applique le LIMIT global de la requête
        // et casse la pagination des réserves elles-mêmes.
        { model: Media, as: 'medias', attributes: ['id', 'type', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return { success: true, reserves: rows, total: count };
  }

  // -------------------- LISTER TOUTES LES RÉSERVES DE L'ORGANISATION --------------------
  /**
   * Liste transversale (tous chantiers confondus) — alimente l'onglet
   * « Réserves » du mobile, qui est un écran de premier niveau et non un
   * sous-écran de chantier. `listReserves` ci-dessus reste la liste
   * PAR chantier : les deux coexistent, elles ne répondent pas à la même
   * question.
   *
   * L'isolation multi-tenant passe par un `include` OBLIGATOIRE sur Chantier
   * filtré par `organisationId` (`required: true`) — jamais par un
   * `chantierId` fourni par le client, qui ne prouve rien.
   */
  static async listToutesReserves(organisationId, {
    page = 1, limit = 20, statut, severite, priorite, chantierId, entrepriseId, assigneA, search,
  } = {}) {
    const where = {};
    if (statut) where.statut = statut;
    if (severite) where.severite = severite;
    if (priorite) where.priorite = priorite;
    if (chantierId) where.chantierId = chantierId;
    if (entrepriseId) where.entrepriseId = entrepriseId;
    if (assigneA) where.assigneA = assigneA;
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { titre: { [Op.iLike]: motif } },
        { description: { [Op.iLike]: motif } },
        { numero: { [Op.iLike]: motif } },
      ];
    }

    const { rows, count } = await Reserve.findAndCountAll({
      where,
      include: [
        { model: Chantier, as: 'chantier', where: { organisationId }, required: true, attributes: ['id', 'nom', 'code'] },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        // Même parti pris que `listReserves` : une seule vignette, pas la
        // galerie (voir le commentaire `separate: true` plus haut).
        { model: Media, as: 'medias', attributes: ['id', 'type', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return { success: true, reserves: rows, total: count };
  }

  // -------------------- DÉTAIL D'UNE RÉSERVE --------------------
  static async getReserve(reserveId, organisationId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [
        // Scoping multi-tenant : le chantier doit appartenir à l'organisation
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom', 'code'] },
        { model: ReservePosition, as: 'position' },
        { model: Media, as: 'medias' },
        { model: Commentaire, as: 'commentaires', include: [{ model: Utilisateur, as: 'auteur', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }] },
        { model: ReserveHistorique, as: 'historiques', include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom'] }] },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
        { model: Utilisateur, as: 'validateur', attributes: ['id', 'nom', 'prenom'] },
        // Extensions module 5
        { model: PieceJointe, as: 'piecesJointes' },
        { model: ReserveAffectation, as: 'affectations' },
      ],
      // CORRECTIF (audit § 9) — un `order` PLACÉ DANS un include est ignoré par
      // Sequelize : l'historique était rendu dans l'ordre arbitraire du plan
      // d'exécution Postgres, alors que la chronologie est la raison d'être de
      // cette table. Le tri doit être exprimé au niveau supérieur.
      order: [
        [{ model: ReserveHistorique, as: 'historiques' }, 'createdAt', 'ASC'],
        [{ model: Commentaire, as: 'commentaires' }, 'createdAt', 'ASC'],
      ],
    });
    if (!reserve || !reserve.chantier) {
      return { success: false, message: 'Réserve introuvable dans cette organisation' };
    }

    // Signatures liées à la réserve (modèle polymorphe)
    const signatures = await Signature.findAll({
      where: { cibleType: 'reserve', cibleId: reserve.id },
      order: [['signe_le', 'DESC']],
    });
    reserve.dataValues.signatures = signatures;

    return { success: true, reserve };
  }

  // -------------------- MODIFIER UNE RÉSERVE --------------------
  static async modifierReserve(organisationId, reserveId, data, utilisateurId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    // CORRECTIF (audit § 9) — aucune garde de statut n'existait ici alors que
    // supprimerReserve en avait une : on pouvait réécrire le titre, la sévérité
    // ou l'entreprise d'une réserve DÉJÀ VALIDÉE, donc altérer après coup ce
    // que le validateur avait approuvé (et ce que le PV de réception atteste).
    if (STATUTS_FIGES.includes(reserve.statut)) {
      return {
        success: false,
        message: 'Une réserve validée ou clôturée ne peut plus être modifiée. Rouvrez-la d’abord.',
      };
    }

    const anciennes = {
      titre: reserve.titre,
      severite: reserve.severite,
      priorite: reserve.priorite,
      categorie: reserve.categorie,
      date_limite: reserve.date_limite,
      assigneA: reserve.assigneA,
      entrepriseId: reserve.entrepriseId,
    };

    // Références inter-tenant (entreprise ET assigné — cf. audit § 8)
    const erreurRef = await ReserveService._verifierReferences(organisationId, data);
    if (erreurRef) return { success: false, message: erreurRef };

    // Cohérence de la localisation : éléments du même chantier que la réserve
    const erreurLoc = await ReserveService._verifierLocalisation(reserve.chantierId, {
      batimentId: data.batimentId !== undefined ? data.batimentId : reserve.batimentId,
      etageId: data.etageId !== undefined ? data.etageId : reserve.etageId,
      zoneId: data.zoneId !== undefined ? data.zoneId : reserve.zoneId,
      planId: data.planId !== undefined ? data.planId : reserve.planId,
      lotId: data.lotId !== undefined ? data.lotId : reserve.lotId,
    });
    if (erreurLoc) return { success: false, message: erreurLoc };

    const updates = {};
    for (const champ of ['titre', 'description', 'severite', 'priorite', 'categorie', 'batimentId', 'etageId', 'zoneId', 'planId', 'lotId', 'entrepriseId', 'assigneA', 'date_limite']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }

    // CORRECTIF (audit § 2) — modification + position + historique atomiques :
    // sans transaction, une réserve pouvait être modifiée sans que la trace
    // correspondante existe.
    const t = await sequelize.transaction();
    try {
      await reserve.update(updates, { transaction: t });

      // Position — mise à jour ou création
      if (data.position) {
        const [position] = await ReservePosition.findOrCreate({
          where: { reserveId: reserve.id },
          defaults: { x: data.position.x, y: data.position.y, zoom: data.position.zoom ?? 1 },
          transaction: t,
        });
        await position.update(
          { x: data.position.x, y: data.position.y, zoom: data.position.zoom ?? 1 },
          { transaction: t }
        );
      }

      // Historique de modification
      await ReserveHistorique.create({
        reserveId: reserve.id,
        utilisateurId,
        action: 'modification',
        anciennes_valeurs: anciennes,
        nouvelles_valeurs: updates,
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Réserve mise à jour avec succès', reserve };
  }

  // -------------------- CHANGER LE STATUT --------------------
  /**
   * Règles métier appliquées :
   *   - transitions contrôlées par la matrice TRANSITIONS ;
   *   - verdict (validee / refusee / cloturee / rouverte) réservé aux rôles de
   *     pilotage ;
   *   - passage à 'validee' : preuves de correction requises (médias),
   *     enregistre validePar + date_validation ;
   *   - passage à 'refusee' : motif obligatoire.
   */
  static async changerStatut(organisationId, reserveId, statut, { motif }, utilisateurId, role) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    // Cloisonnement du contrôle qualité : l'entreprise qui exécute les travaux
    // ne peut pas prononcer le verdict sur sa propre réserve, ni le défaire en
    // rouvrant la réserve (cf. STATUTS_CONTROLE en tête de fichier).
    if (STATUTS_CONTROLE.includes(statut) && role !== 'Admin' && !PILOTAGE.includes(role)) {
      return {
        success: false,
        message: 'Votre rôle ne permet pas de valider, refuser, rouvrir ou clôturer une réserve. Déclarez la correction, un contrôleur la vérifiera.',
      };
    }

    const statutsAutorises = TRANSITIONS[reserve.statut] || [];
    if (!statutsAutorises.includes(statut)) {
      return {
        success: false,
        message: `Transition impossible : ${reserve.statut} → ${statut}.`,
      };
    }

    const ancienStatut = reserve.statut;
    const updates = { statut };

    if (statut === 'validee') {
      // Preuves de correction obligatoires
      const preuves = await Media.count({ where: { reserveId: reserve.id } });
      if (preuves === 0) {
        return {
          success: false,
          message: 'Une réserve ne peut être validée qu’avec des preuves de correction (photo, vidéo ou note vocale).',
        };
      }
      updates.validePar = utilisateurId;
      updates.date_validation = new Date();
      updates.motif_refus = null;
    }

    if (statut === 'refusee') {
      if (!motif) return { success: false, message: 'Le motif du refus est obligatoire.' };
      updates.motif_refus = motif;
      updates.validePar = null;
      updates.date_validation = null;
    }

    if (statut !== 'validee' && statut !== 'refusee') {
      updates.validePar = null;
      updates.date_validation = null;
      updates.motif_refus = null;
    }

    // CORRECTIF (audit § 2) — changement de statut et sa trace d'historique
    // sont indissociables : un statut modifié sans historique rend le PV de
    // réception incontestablement faux.
    const t = await sequelize.transaction();
    try {
      await reserve.update(updates, { transaction: t });

      await ReserveHistorique.create({
        reserveId: reserve.id,
        utilisateurId,
        action: statut === 'refusee' ? 'refus' : statut === 'validee' ? 'validation' : 'statut',
        anciennes_valeurs: { statut: ancienStatut },
        nouvelles_valeurs: { statut },
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    // Notification métier (module 8) — hors transaction, best-effort
    const dest = reserve.creePar === utilisateurId ? reserve.assigneA : reserve.creePar;
    if (dest) {
      await NotificationService.notifier({
        utilisateurId: dest,
        type: 'reserve.statut',
        titre: `Réserve ${statut === 'validee' ? 'validée' : statut === 'refusee' ? 'refusée' : statut}`,
        message: `La réserve ${reserve.numero} « ${reserve.titre} » est passée au statut « ${statut} ».`,
        donnees: { reserveId: reserve.id, statut },
      });
    }

    return { success: true, message: `Statut mis à jour : ${statut}`, reserve };
  }

  // -------------------- COMMENTAIRES --------------------
  static async ajouterCommentaire(organisationId, reserveId, message, utilisateurId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    // CORRECTIF (audit § 2) — commentaire + historique atomiques
    const t = await sequelize.transaction();
    let commentaire;
    try {
      commentaire = await Commentaire.create({
        reserveId,
        utilisateurId,
        message,
      }, { transaction: t });

      await ReserveHistorique.create({
        reserveId,
        utilisateurId,
        action: 'commentaire',
        nouvelles_valeurs: { message },
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Commentaire ajouté', commentaire };
  }

  static async listCommentaires(organisationId, reserveId) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    const commentaires = await Commentaire.findAll({
      where: { reserveId },
      include: [{ model: Utilisateur, as: 'auteur', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }],
      order: [['createdAt', 'ASC']],
    });
    return { success: true, commentaires };
  }

  // -------------------- SUPPRIMER UNE RÉSERVE --------------------
  static async supprimerReserve(organisationId, reserveId, utilisateurId = null) {
    const reserve = await Reserve.findByPk(reserveId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!reserve) return { success: false, message: 'Réserve introuvable dans cette organisation' };

    // Règle métier : une réserve validée ou clôturée ne peut pas être supprimée
    if (STATUTS_FIGES.includes(reserve.statut)) {
      return { success: false, message: 'Une réserve validée ou clôturée ne peut pas être supprimée.' };
    }

    // CORRECTIF (audit § 2 / § 4) — soft delete EXPLICITEMENT en cascade sur
    // les entités filles paranoid. Les `onDelete: CASCADE` déclarés dans
    // models/index.js sont des contraintes SQL : elles ne se déclenchent QUE
    // sur un DELETE réel, jamais sur l'UPDATE deleted_at d'un soft delete.
    // Sans ce bloc, pièces jointes et commentaires restaient « vivants ».
    const t = await sequelize.transaction();
    try {
      await ReserveService._supprimerFillesReserve([reserveId], t);

      // Trace avant disparition — l'historique n'est pas paranoid, il survit
      await ReserveHistorique.create({
        reserveId,
        utilisateurId,
        action: 'suppression',
        anciennes_valeurs: { statut: reserve.statut, numero: reserve.numero },
      }, { transaction: t });

      await reserve.destroy({ transaction: t }); // soft delete
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Réserve supprimée' };
  }

  /**
   * Soft delete des entités filles paranoid d'un lot de réserves.
   * Utilisé ici et par ChantierService lors de la suppression d'un chantier.
   * Les tables non paranoid (positions, historiques, médias) sont conservées :
   * elles portent la traçabilité et les fichiers, qu'un `restore` doit pouvoir
   * retrouver intacts (cf. décision documentée sur deleteFile, audit § 5).
   */
  static async _supprimerFillesReserve(reserveIds, transaction) {
    if (!reserveIds.length) return;
    const where = { reserveId: { [Op.in]: reserveIds } };
    await Commentaire.destroy({ where, transaction });
    await PieceJointe.destroy({ where, transaction });
  }
}

module.exports = ReserveService;
