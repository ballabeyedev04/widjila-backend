'use strict';

const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const {
  Reserve, ReservePosition, ReserveHistorique, Commentaire, Media, CorpsEtat, Phase,
  Chantier, Batiment, Etage, Zone, Lot, Plan, Organisation, Utilisateur,
  PieceJointe, ReserveAffectation, Signature, Partenaire,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const NotificationService = require('../../notification/service/notification.service.js');
const escapeLike = require('../../../utils/escapeLike.js');
const { PILOTAGE } = require('../../../config/roles.js');
// Statuts du CIRCUIT de validation : un chantier qui les porte n'existe pas
// encore comme chantier.
const { STATUT_CHANTIER_EN_DEMANDE } = require('../../../config/enums.js');

// ─── Statuts que le sous-traitant peut lui-même déclarer ───────────────────────
// Il ne peut ni affecter (déjà fait par un rôle de pilotage), ni prononcer de
// verdict (bloqué plus bas par STATUTS_CONTROLE), ni rouvrir. Seule sa propre
// progression sur SA réserve assignée : accusé de réception, démarrage, fin.
const STATUTS_SOUS_TRAITANT = ['prise_en_charge', 'en_cours', 'corrigee'];

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
  creee:           ['affectee', 'en_cours', 'rouverte'],
  // `prise_en_charge` : étape optionnelle (accusé de réception du sous-traitant).
  // `affectee → en_cours`/`corrigee` restent légaux pour les rôles qui ne
  // l'utilisent pas — voir le commentaire de classe dans reserve.model.js.
  affectee:        ['prise_en_charge', 'en_cours', 'corrigee', 'rouverte'],
  prise_en_charge: ['en_cours', 'corrigee', 'rouverte'],
  en_cours:        ['corrigee', 'a_verifier', 'rouverte'],
  corrigee:        ['a_verifier', 'validee', 'refusee', 'rouverte'],
  a_verifier:      ['validee', 'refusee', 'en_cours', 'rouverte'],
  validee:         ['cloturee', 'rouverte'],
  refusee:         ['en_cours', 'corrigee', 'rouverte'],
  rouverte:        ['affectee', 'prise_en_charge', 'en_cours', 'corrigee', 'a_verifier'],
  // Positionné automatiquement par le job (module 5) ; reprise du cycle normal.
  //
  // Ni `validee` ni `refusee` : le job ne marque en retard que du travail
  // NON ENCORE déclaré fait (voir markReservesEnRetard.job.js). Un verdict
  // direct depuis ce statut validait une réserve jamais corrigée — la photo de
  // constat prise à la création suffisait comme « preuve ». La réserve repasse
  // par `corrigee` / `a_verifier`, comme toutes les autres.
  en_retard:       ['affectee', 'prise_en_charge', 'en_cours', 'corrigee', 'a_verifier', 'rouverte'],
  cloturee:        [],
};

// Statuts figés : la réserve a reçu son verdict, elle n'est plus modifiable
// (aligné sur la règle déjà appliquée par supprimerReserve).
const STATUTS_FIGES = ['validee', 'cloturee'];

// Champs qu'une MODIFICATION peut écrire — et seuls ceux-là peuvent entrer en
// conflit (voir `_conflitsModification`).
const CHAMPS_MODIFIABLES = [
  'titre', 'description', 'severite', 'priorite', 'categorie', 'corpsEtatId', 'phaseId',
  'batimentId', 'etageId', 'zoneId', 'planId', 'lotId', 'entrepriseId', 'partenaireId',
  'assigneA', 'date_limite',
];

// Statuts d'un chantier FERMÉ : plus aucune réserve ne s'y ajoute.
const STATUTS_CHANTIER_FERMES = ['cloture', 'archive'];

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
      // `required: true` sur l'étage — CORRECTIF (audit sécurité) : sans lui,
      // le filtre `chantierId` ne portait que sur une jointure EXTERNE
      // (`LEFT JOIN (etages INNER JOIN batiments …)`) et toute zone de la
      // plateforme était acceptée, y compris celle d'une autre organisation.
      const z = await Zone.findOne({
        where: { id: zoneId },
        include: [{ model: Etage, as: 'etage', required: true, attributes: [], include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: [] }] }],
      });
      if (!z) return 'Zone non rattachée à ce chantier';
    }
    if (planId) {
      const p = await Plan.findOne({ where: { id: planId, chantierId } });
      if (!p) return 'Plan non rattaché à ce chantier';
      // Un plan en attente appartient à un chantier qui n'existe pas encore :
      // une réserve posée dessus survivrait à un refus, rattachée à un plan
      // que personne ne validera jamais. Le client l'a demandé pour l'écran
      // de validation ; la garde vit ici, où elle couvre tous les chemins.
      if (p.statut === 'en_attente_validation') {
        return 'Ce plan attend une validation : aucune réserve ne peut y être posée.';
      }
    }
    if (lotId) {
      const l = await Lot.findOne({ where: { id: lotId, chantierId } });
      if (!l) return 'Lot non rattaché à ce chantier';
    }
    return null;
  }

  // -------------------- LOCALISATION HÉRITÉE DU PLAN --------------------
  /**
   * Complète la localisation d'une réserve À PARTIR DU PLAN sur lequel elle a
   * été posée.
   *
   * ── Pourquoi ────────────────────────────────────────────────────────────
   *
   * La localisation d'une réserve ne se saisit plus : on ouvre un plan, on
   * appuie à l'endroit du défaut, et c'est fini. Le couple
   * (`planId`, `position`) dit tout — le plan désigne le lieu, le point y
   * désigne l'endroit exact. L'ancienne cascade « bâtiment → étage → zone »
   * demandait la même information une seconde fois, à la main, et pouvait donc
   * la contredire.
   *
   * Mais RIEN dans l'application n'a été réécrit pour se passer de ces trois
   * champs : les rapports, les filtres, l'export Excel et le tableau de bord
   * regroupent tous par bâtiment et par étage. Les laisser vides viderait ces
   * écrans pour toute réserve créée depuis le nouveau parcours.
   *
   * ── La règle ────────────────────────────────────────────────────────────
   *
   * Un plan PORTE déjà sa place dans la structure (`plan.service.js`
   * #_resoudreRattachement, qui la fait même hériter au plan de détail). On la
   * recopie donc sur la réserve, et on n'écrase JAMAIS ce que le client a
   * envoyé : un appelant qui précise encore l'étage garde le sien, et les
   * intégrations existantes ne changent pas de comportement.
   *
   * Silencieux quand le plan n'a aucun rattachement (plan global d'un chantier
   * sans structure saisie) : la réserve reste alors localisée par son plan et
   * son point, ce qui est exactement l'intention.
   */
  static async _heriterLocalisationDuPlan(data) {
    if (!data.planId) return data;
    if (data.batimentId || data.etageId || data.zoneId) return data;

    const plan = await Plan.findByPk(data.planId, {
      attributes: ['id', 'batimentId', 'etageId', 'zoneId'],
    });
    if (!plan) return data;

    data.batimentId = plan.batimentId || null;
    data.etageId = plan.etageId || null;
    data.zoneId = plan.zoneId || null;
    return data;
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
  /**
   * Le partenaire choisi comme « entreprise concernée » doit appartenir à
   * l'annuaire de CETTE organisation : `partenaireId` est un simple UUID dans
   * le corps de la requête, rien n'empêcherait sinon de désigner l'entreprise
   * d'un autre client — et la jointure la ferait apparaître dans une réserve
   * qui ne la concerne pas.
   */
  static async _verifierPartenaire(organisationId, partenaireId) {
    const partenaire = await Partenaire.findOne({
      where: { id: partenaireId, organisationId },
      attributes: ['id'],
    });
    return partenaire ? null : 'Entreprise introuvable dans cette organisation';
  }

  /**
   * La phase choisie doit être VISIBLE par cette organisation.
   *
   * `phaseId` arrive en simple UUID dans le corps de la requête, et rien ne
   * le contrôlait : on pouvait rattacher une réserve à la phase d'un autre
   * client, dont le nom réapparaissait ensuite dans chaque lecture de la
   * réserve — une fuite inter-tenant par simple jointure.
   *
   * Visible = référentiel standard de la plateforme (`organisationId` NULL) ou
   * phase propre à l'organisation. Même règle que `_visibilite` du service de
   * référentiel, et même restriction au référentiel (`chantierId` NULL) : les
   * phases de PLANNING d'un chantier ne sont pas des valeurs de ce champ.
   */
  static async _verifierPhase(organisationId, phaseId) {
    const phase = await Phase.findOne({
      where: {
        id: phaseId,
        chantierId: null,
        [Op.or]: [{ organisationId: null }, { organisationId }],
      },
      attributes: ['id'],
    });
    return phase ? null : 'Phase introuvable dans le référentiel de votre organisation';
  }

  /** Même contrôle pour le corps d'état — voir [_verifierPhase]. */
  static async _verifierCorpsEtat(organisationId, corpsEtatId) {
    const corpsEtat = await CorpsEtat.findOne({
      where: {
        id: corpsEtatId,
        [Op.or]: [{ organisationId: null }, { organisationId }],
      },
      attributes: ['id'],
    });
    return corpsEtat ? null : 'Corps d’état introuvable dans le référentiel de votre organisation';
  }

  static async _verifierReferences(organisationId, data) {
    if (data.entrepriseId) {
      const erreur = await ReserveService._verifierEntreprise(organisationId, data.entrepriseId);
      if (erreur) return erreur;
    }
    if (data.partenaireId) {
      const erreur = await ReserveService._verifierPartenaire(organisationId, data.partenaireId);
      if (erreur) return erreur;
    }
    if (data.assigneA) {
      const erreur = await ReserveService._verifierAssigne(organisationId, data.assigneA);
      if (erreur) return erreur;
    }
    if (data.phaseId) {
      const erreur = await ReserveService._verifierPhase(organisationId, data.phaseId);
      if (erreur) return erreur;
    }
    if (data.corpsEtatId) {
      const erreur = await ReserveService._verifierCorpsEtat(organisationId, data.corpsEtatId);
      if (erreur) return erreur;
    }
    return null;
  }

  /**
   * Un chantier qui n'existe pas encore n'accueille pas de réserve.
   *
   * La garde vivait au niveau du PLAN seulement : une réserve posée sans plan
   * — ce que l'application permet, un chantier dont les plans ne sont pas
   * encore déposés ne devant pas bloquer un relevé — passait donc sur une
   * DEMANDE en attente. Refusée ensuite, la demande laissait des réserves
   * rattachées à un chantier que personne ne validera jamais.
   *
   * Règle donnée par le client : les réserves viennent APRÈS la validation du
   * chantier et de ses plans.
   *
   * @returns {string|null} Message de refus, ou `null`.
   */
  static _refusSurDemande(chantier) {
    // Chantier FERMÉ : clôturé ou archivé, il n'accepte plus de travail. La
    // clôture exige zéro réserve ouverte — en créer une après la rendait
    // fausse (chantier.service.js#changerStatut).
    if (STATUTS_CHANTIER_FERMES.includes(chantier.statut)) {
      return 'Ce chantier est clôturé ou archivé : aucune réserve ne peut y être ajoutée.';
    }
    if (!STATUT_CHANTIER_EN_DEMANDE.includes(chantier.statut)) return null;
    return chantier.statut === 'rejete'
      ? 'Cette demande de chantier a été refusée : aucune réserve ne peut y être posée.'
      : 'Ce chantier attend une validation : aucune réserve ne peut y être posée.';
  }

  // -------------------- CRÉER UNE RÉSERVE --------------------
  static async creerReserve(organisationId, data, utilisateurId) {
    const chantier = await Chantier.findOne({ where: { id: data.chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const refus = ReserveService._refusSurDemande(chantier);
    if (refus) return { success: false, message: refus };

    // IDEMPOTENCE (mode hors ligne du mobile) : le client fournit l'id, et
    // peut renvoyer la meme creation si la reponse s'est perdue en route
    // (reseau coupe juste apres l'ecriture serveur). Rejouer doit alors etre
    // SANS EFFET et repondre succes, sinon la file d'attente du mobile
    // resterait bloquee sur une erreur de doublon indepassable.
    if (data.id) {
      const existante = await Reserve.findOne({
        where: { id: data.id },
        include: [{ model: Chantier, as: 'chantier', attributes: ['organisationId'] }],
      });
      if (existante) {
        // Ne jamais confirmer une reserve d'une AUTRE organisation : un id
        // devine ne doit pas devenir une fuite d'information.
        if (existante.chantier?.organisationId !== organisationId) {
          return { success: false, message: 'Identifiant de reserve deja utilise' };
        }
        return {
          success: true,
          message: 'Reserve deja enregistree',
          reserve: await ReserveService._reponseEcriture(existante, organisationId),
          rejeu: true,
        };
      }
    }

    const erreurRef = await ReserveService._verifierReferences(organisationId, data);
    if (erreurRef) return { success: false, message: erreurRef };

    const erreurLoc = await ReserveService._verifierLocalisation(data.chantierId, data);
    if (erreurLoc) return { success: false, message: erreurLoc };

    // Le plan devient la source de la localisation : bâtiment, étage et zone
    // en sont DÉDUITS quand le client ne les a pas envoyés. Voir
    // `_heriterLocalisationDuPlan`.
    await ReserveService._heriterLocalisationDuPlan(data);

    // CORRECTIF (audit § 2) — atomicité. Réserve + position + historique
    // formaient trois écritures indépendantes : un échec sur la 2ᵉ laissait une
    // réserve sans position ni trace d'historique, en violation de la règle
    // « toute modification est historisée ».
    let reserve;
    try {
      reserve = await ReserveService._creerDansTransaction(data, utilisateurId);
    } catch (err) {
      // CORRECTIF (audit synchronisation) — course entre deux envois du MÊME
      // identifiant client. Le contrôle d'idempotence plus haut lit AVANT
      // d'écrire : si la première requête n'a pas encore validé sa
      // transaction, la seconde ne voit rien et heurte la clé primaire.
      // L'erreur remontait en 409 ; le mobile la classait en refus définitif
      // et effaçait de son cache une réserve pourtant bien créée.
      const rejeu = await ReserveService._resoudreCollisionIdentifiant(err, data, organisationId);
      if (!rejeu) throw err;
      return rejeu;
    }

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

    return {
      success: true,
      message: 'Réserve créée avec succès',
      reserve: await ReserveService._reponseEcriture(reserve, organisationId),
    };
  }

  /**
   * Collision d'unicité pendant une création : rejeu légitime, ou vraie erreur ?
   *
   * Ne répond un résultat QUE si l'appelant a fourni son propre identifiant et
   * que la collision porte sur lui (clé primaire) — c'est la signature d'un
   * rejeu hors ligne. Tout autre cas renvoie `null` : l'erreur d'origine doit
   * alors remonter telle quelle, jamais être maquillée en succès.
   *
   * @returns {Promise<object|null>} Résultat de service, ou `null`.
   */
  static async _resoudreCollisionIdentifiant(err, data, organisationId) {
    if (!data.id || !(err instanceof UniqueConstraintError) || _estCollisionNumero(err)) return null;

    // `paranoid: false` : une réserve supprimée depuis garde sa ligne (et
    // donc sa clé primaire). Sans cette option, on ne la verrait pas et on
    // ne saurait pas expliquer le refus.
    const existante = await Reserve.findOne({
      where: { id: data.id },
      paranoid: false,
      include: [{ model: Chantier, as: 'chantier', attributes: ['organisationId'], paranoid: false }],
    });
    if (!existante) return null;

    // Même règle que le contrôle d'idempotence : jamais de confirmation d'un
    // identifiant appartenant à une autre organisation.
    if (existante.chantier?.organisationId !== organisationId) {
      return { success: false, message: 'Identifiant de reserve deja utilise' };
    }
    if (existante.deletedAt) {
      return { success: false, message: 'Cette réserve a été supprimée entre-temps : elle ne peut pas être recréée.' };
    }
    logger.info(`[reserve] Création rejouée en concurrence (id ${data.id}) — réserve existante renvoyée`);
    return {
      success: true,
      message: 'Reserve deja enregistree',
      reserve: await ReserveService._reponseEcriture(existante, organisationId),
      rejeu: true,
    };
  }

  /** Réserve + position + historique, dans UNE transaction (avec réessai de numéro). */
  static async _creerDansTransaction(data, utilisateurId) {
    return _avecReessaiNumero(async () => {
      const t = await sequelize.transaction();
      try {
        const numero = await ReserveService._prochainNumero(data.chantierId, t);

        const creee = await Reserve.create({
          // `undefined` (et non `null`) quand le client n'en fournit pas :
          // Sequelize applique alors son `defaultValue: UUIDV4`.
          id: data.id || undefined,
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
          corpsEtatId: data.corpsEtatId || null,
          phaseId: data.phaseId || null,
          entrepriseId: data.entrepriseId || null,
          partenaireId: data.partenaireId || null,
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
            // CORRECTIF (audit synchronisation) — la page était validée par
            // Joi puis IGNORÉE ici : toute réserve posée sur la page 7 d'un
            // PDF était enregistrée sur la page 1. Le mobile, lui, gardait la
            // page 7 : local et serveur divergeaient dès la création.
            page: data.position.page ?? 1,
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

    // Même garde que la création unitaire : la série est un autre chemin vers
    // la même écriture, et une garde posée sur un seul des deux ne garde rien.
    const refusDemande = ReserveService._refusSurDemande(chantier);
    if (refusDemande) return { success: false, message: refusDemande };

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

    // Même règle qu'à la création unitaire : toute la série partage le plan, et
    // en hérite donc la localisation.
    await ReserveService._heriterLocalisationDuPlan(data);

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
            corpsEtatId: data.corpsEtatId || null,
            phaseId: data.phaseId || null,
            entrepriseId: data.entrepriseId || null,
            partenaireId: data.partenaireId || null,
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
          corpsEtatId: reserve.corpsEtatId,
          phaseId: reserve.phaseId,
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
    phaseId, corpsEtatId, partenaireId,
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
    // Filtres d'HISTORIQUE : « réserves de cette phase », « réserves de cette
    // entreprise », et leur combinaison — c'est ce croisement qui alimente
    // l'écran d'historique par entreprise, filtrable par phase.
    if (phaseId) where.phaseId = phaseId;
    if (corpsEtatId) where.corpsEtatId = corpsEtatId;
    if (partenaireId) where.partenaireId = partenaireId;
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
        { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
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
  /**
   * @param {object} [portee]
   * @param {boolean} [portee.toutesOrganisations]  Ignore le filtre par
   *   organisation. RÉSERVÉ au super-admin plateforme, qui n'en a pas : sans
   *   cela la liste transversale des réserves lui répondait toujours vide, la
   *   jointure filtrant sur son propre `organisationId` — c'est-à-dire `null`.
   *   Posé par le contrôleur d'après le rôle, JAMAIS d'après un paramètre client.
   * @param {object|null} [auteur]  Compte appelant (`req.user`). Restreint la
   *   liste aux chantiers qu'il a le droit d'ouvrir — voir
   *   `ChantierService.filtreCloisonnement`. Sans lui (audit sécurité), un
   *   sous-traitant ou un client listait les réserves, et le nom, de chantiers
   *   demandés par d'autres qu'il ne pouvait pourtant pas ouvrir.
   */
  static async listToutesReserves(organisationId, {
    page = 1, limit = 20, statut, severite, priorite, chantierId, entrepriseId, assigneA, search,
    phaseId, corpsEtatId, partenaireId,
  } = {}, { toutesOrganisations = false } = {}, auteur = null) {
    const cloisonnement = require('../../chantier/service/chantier.service.js').filtreCloisonnement(auteur);
    const whereChantier = (toutesOrganisations && !organisationId) ? {} : { organisationId };
    if (cloisonnement) Object.assign(whereChantier, cloisonnement);

    const where = {};
    if (statut) where.statut = statut;
    if (severite) where.severite = severite;
    if (priorite) where.priorite = priorite;
    if (chantierId) where.chantierId = chantierId;
    if (entrepriseId) where.entrepriseId = entrepriseId;
    if (assigneA) where.assigneA = assigneA;
    // Filtres d'HISTORIQUE : « réserves de cette phase », « réserves de cette
    // entreprise », et leur combinaison — c'est ce croisement qui alimente
    // l'écran d'historique par entreprise, filtrable par phase.
    if (phaseId) where.phaseId = phaseId;
    if (corpsEtatId) where.corpsEtatId = corpsEtatId;
    if (partenaireId) where.partenaireId = partenaireId;
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
        {
          model: Chantier, as: 'chantier', required: true, attributes: ['id', 'nom', 'code'],
          // Organisation (facultative pour le super-admin qui cible une
          // organisation précise) + cloisonnement par chantier de l'appelant.
          where: whereChantier,
          include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'] }],
        },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        // L'AUTEUR du constat. `listReserves` le joignait, pas celle-ci — et
        // les deux alimentent le MÊME rendu de carte, qui affiche « qui a
        // relevé ça, et quand ». La ligne perdait donc son auteur sur l'onglet
        // « Réserves » et sur l'accueil, c'est-à-dire sur les deux listes les
        // plus consultées. Trois colonnes, sur une jointure du même genre que
        // celle d'`assigne` juste au-dessus.
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
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

  /**
   * Relit une réserve AVEC ses associations, pour la réponse d'une écriture
   * — deuxième audit synchronisation, A2-03.
   *
   * Création, changement de statut et modification répondaient la ligne
   * BRUTE : ni plan, ni phase, ni position, ni photos, ni historique. Le
   * mobile écrit cette réponse telle quelle dans son cache et l'affiche : après
   * un changement de statut, la fiche montrait 0 photo (et ne proposait donc
   * plus « validée »), plus d'aperçu du plan ni d'historique, et la réserve
   * perdait son repère hors ligne jusqu'au tirage suivant.
   *
   * Plus légère que `getReserve` : ni commentaires, ni pièces jointes, ni
   * signatures — ils ont leurs propres routes.
   *
   * @returns {Promise<object|null>} la réserve complète, ou `null` si son
   *   chantier n'est pas (ou plus) dans cette organisation.
   */
  static async _relire(reserveId, organisationId) {
    return Reserve.findByPk(reserveId, {
      include: [
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom', 'code', 'organisationId'] },
        { model: ReservePosition, as: 'position' },
        { model: Plan, as: 'plan', attributes: ['id', 'nom', 'version', 'fichier_url', 'format'], required: false },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
        { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
        { model: Lot, as: 'lot', attributes: ['id', 'nom'] },
        { model: Batiment, as: 'batiment', attributes: ['id', 'nom'] },
        { model: Etage, as: 'etage', attributes: ['id', 'nom'] },
        { model: Zone, as: 'zone', attributes: ['id', 'nom'] },
        { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
        { model: Media, as: 'medias' },
        { model: ReserveHistorique, as: 'historiques', include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom'] }] },
      ],
      order: [[{ model: ReserveHistorique, as: 'historiques' }, 'createdAt', 'ASC']],
    });
  }

  /** La réserve relue pour la réponse — ou la ligne écrite, si la relecture ne rend rien. */
  static async _reponseEcriture(ligne, organisationId) {
    return (await ReserveService._relire(ligne.id, organisationId)) || ligne;
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
        // LE PLAN — il manquait, et c'est pourtant la localisation principale
        // d'une réserve depuis que le relevé se fait en appuyant sur un plan.
        // Le détail affichait bâtiment, étage et zone (déduits du plan par
        // `_heriterLocalisationDuPlan`) mais jamais le plan lui-même : on ne
        // pouvait pas savoir SUR QUEL document la réserve avait été posée, ni
        // y revenir. `required: false` — une réserve relevée avant le dépôt
        // des plans n'en a pas.
        { model: Plan, as: 'plan', attributes: ['id', 'nom', 'version', 'fichier_url', 'format'], required: false },
        { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
        { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
        { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] },
        { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
        { model: Utilisateur, as: 'assigne', attributes: ['id', 'nom', 'prenom', 'photoProfil'] },
        { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom'] },
        { model: Utilisateur, as: 'validateur', attributes: ['id', 'nom', 'prenom'] },
        // Extensions module 5
        { model: PieceJointe, as: 'piecesJointes' },
        // Les affectations avec LEUR DESTINATAIRE.
        //
        // Elles remontaient nues — trois clés étrangères, aucun nom — et le
        // client affichait « — » à la place de l'intervenant. La liste dédiée
        // (`/reserves/:id/affectations`) joignait déjà ces trois modèles ; le
        // détail, lui, ne le faisait pas, et les deux écrans ne montraient donc
        // pas la même chose pour la même donnée.
        {
          model: ReserveAffectation,
          as: 'affectations',
          required: false,
          include: [
            { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'photoProfil'], required: false },
            { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'], required: false },
            { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'type'], required: false },
          ],
        },
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

  /**
   * Conflits entre une modification et l'état ACTUEL de la réserve —
   * deuxième audit synchronisation, A2-13.
   *
   * Le client envoie, avec les champs modifiés, les valeurs qu'il avait SOUS
   * LES YEUX (`valeursInitiales`). Pour chaque champ :
   *  - personne n'y a touché depuis (valeur actuelle = valeur initiale) : on
   *    applique ;
   *  - il porte DÉJÀ la valeur demandée : c'est un rejeu, rien à signaler ;
   *  - sinon, quelqu'un l'a modifié entre-temps : CONFLIT, et rien n'est
   *    écrit — la seconde modification écrasait la première sans que personne
   *    le sache (un titre corrigé depuis le web, perdu au rejeu d'une saisie
   *    hors ligne).
   *
   * Des champs DIFFÉRENTS modifiés par deux personnes ne sont pas en conflit.
   * Sans `valeursInitiales` (web, ancien client), le comportement historique
   * est conservé.
   */
  static _conflitsModification(reserve, data) {
    const initiales = data.valeursInitiales;
    if (!initiales || typeof initiales !== 'object') return [];

    const comparable = (champ, valeur) => {
      if (valeur === undefined || valeur === null || valeur === '') return null;
      if (champ === 'date_limite') {
        // « 2026-09-30 » et « 2026-09-30T00:00:00.000Z » sont la même échéance.
        if (valeur instanceof Date) return Number.isNaN(valeur.getTime()) ? null : valeur.toISOString().slice(0, 10);
        const texte = String(valeur);
        return /^\d{4}-\d{2}-\d{2}/.test(texte) ? texte.slice(0, 10) : texte;
      }
      return String(valeur);
    };

    const conflits = [];
    for (const champ of Object.keys(initiales)) {
      if (!CHAMPS_MODIFIABLES.includes(champ) || data[champ] === undefined) continue;
      const actuelle = comparable(champ, reserve[champ]);
      if (actuelle === comparable(champ, initiales[champ])) continue; // personne n'y a touché
      if (actuelle === comparable(champ, data[champ])) continue; // déjà la valeur voulue : rejeu
      conflits.push({ champ, valeurServeur: reserve[champ] ?? null, valeurDemandee: data[champ] });
    }
    return conflits;
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

    // A2-13 — rien n'est écrit si un champ modifié l'a été ailleurs entre-temps.
    const conflits = ReserveService._conflitsModification(reserve, data);
    if (conflits.length) {
      return {
        success: false,
        code: 'CONFLIT_MODIFICATION',
        message: `Modifié par quelqu’un d’autre entre-temps : ${conflits.map((c) => c.champ).join(', ')}. `
          + 'Rechargez la réserve pour voir la version actuelle avant de la modifier.',
        conflits,
      };
    }

    const anciennes = {
      titre: reserve.titre,
      severite: reserve.severite,
      priorite: reserve.priorite,
      categorie: reserve.categorie,
      corpsEtatId: reserve.corpsEtatId,
      phaseId: reserve.phaseId,
      date_limite: reserve.date_limite,
      assigneA: reserve.assigneA,
      entrepriseId: reserve.entrepriseId,
      partenaireId: reserve.partenaireId,
    };

    // Références inter-tenant : entreprise, assigné, phase et corps d'état.
    // Tous sont des UUID fournis par le client — aucun n'est digne de confiance.
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
    for (const champ of CHAMPS_MODIFIABLES) {
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

    return {
      success: true,
      message: 'Réserve mise à jour avec succès',
      reserve: await ReserveService._reponseEcriture(reserve, organisationId),
    };
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

    // Le sous-traitant ne peut agir QUE sur la réserve qui lui est assignée
    // (affectation principale ou secondaire), et seulement pour déclarer sa
    // propre progression — jamais pour ré-affecter ni rouvrir.
    if (role === 'SousTraitant') {
      if (!STATUTS_SOUS_TRAITANT.includes(statut)) {
        return {
          success: false,
          message: 'En tant que sous-traitant, vous pouvez uniquement prendre en charge, démarrer ou déclarer terminée une réserve qui vous est assignée.',
        };
      }
      const estAssigne = reserve.assigneA === utilisateurId ||
        (await ReserveAffectation.count({ where: { reserveId: reserve.id, utilisateurId } })) > 0;
      if (!estAssigne) {
        return { success: false, message: 'Cette réserve ne vous est pas assignée.' };
      }
    }

    // CORRECTIF (audit synchronisation) — rejeu d'un changement DÉJÀ appliqué.
    // Le mobile renvoie l'action quand la réponse s'est perdue ; le serveur
    // voyait « corrigée → corrigée », hors matrice, et répondait 400. Le mobile
    // en faisait un échec définitif pour un changement pourtant enregistré.
    // Placé APRÈS les contrôles de droits : un rejeu ne contourne rien.
    // Aucune écriture, aucun historique, aucune notification : rien n'a changé.
    if (reserve.statut === statut) {
      return {
        success: true,
        message: `Statut déjà à jour : ${statut}`,
        reserve: await ReserveService._reponseEcriture(reserve, organisationId),
        rejeu: true,
      };
    }

    const statutsAutorises = TRANSITIONS[reserve.statut] || [];
    if (!statutsAutorises.includes(statut)) {
      return {
        success: false,
        message: `Transition impossible : ${reserve.statut} → ${statut}.`,
      };
    }

    let ancienStatut = reserve.statut;
    const updates = { statut };

    if (statut === 'validee') {
      // Les preuves de correction sont exigées plus bas, SOUS LE VERROU : c'est
      // l'état au moment de l'écriture qui compte, pas celui d'une lecture
      // antérieure.
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
      // A2-06 — relecture VERROUILLÉE (FOR UPDATE) avant d'écrire.
      //
      // Les contrôles ci-dessus portent sur une lecture SANS verrou. Deux
      // changements simultanés — « validée » par l'un, « en cours » par
      // l'autre — étaient donc jugés tous deux contre le MÊME état de départ,
      // et passaient tous deux : la réserve finissait « en cours » après avoir
      // été validée, transition interdite, et le verdict disparaissait.
      //
      // Le verrou fait attendre le second jusqu'à la fin du premier ; il est
      // alors REJUGÉ sur l'état réellement laissé.
      const verrouillee = await Reserve.findByPk(reserve.id, {
        transaction: t,
        lock: t.LOCK?.UPDATE ?? true,
      });
      if (!verrouillee) {
        await t.rollback();
        return { success: false, message: 'Réserve introuvable dans cette organisation' };
      }
      if (verrouillee.statut !== ancienStatut) {
        if (verrouillee.statut === statut) {
          // L'autre requête a fait exactement ce qu'on demandait : rejeu.
          await t.rollback();
          return {
            success: true,
            message: `Statut déjà à jour : ${statut}`,
            reserve: await ReserveService._reponseEcriture(verrouillee, organisationId),
            rejeu: true,
          };
        }
        if (!(TRANSITIONS[verrouillee.statut] || []).includes(statut)) {
          await t.rollback();
          return { success: false, message: `Transition impossible : ${verrouillee.statut} → ${statut}.` };
        }
        ancienStatut = verrouillee.statut;
      }

      if (statut === 'validee') {
        // Preuves de correction obligatoires — comptées dans la transaction.
        const preuves = await Media.count({ where: { reserveId: reserve.id }, transaction: t });
        if (preuves === 0) {
          await t.rollback();
          return {
            success: false,
            message: 'Une réserve ne peut être validée qu’avec des preuves de correction (photo, vidéo ou note vocale).',
          };
        }
      }

      await verrouillee.update(updates, { transaction: t });

      await ReserveHistorique.create({
        reserveId: reserve.id,
        utilisateurId,
        action: statut === 'refusee' ? 'refus' : statut === 'validee' ? 'validation' : 'statut',
        anciennes_valeurs: { statut: ancienStatut },
        nouvelles_valeurs: { statut },
      }, { transaction: t });

      await t.commit();
    } catch (err) {
      // `finished` : un refus ci-dessus a déjà annulé la transaction.
      if (!t.finished) await t.rollback();
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

    return {
      success: true,
      message: `Statut mis à jour : ${statut}`,
      reserve: await ReserveService._reponseEcriture(reserve, organisationId),
    };
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
    if (!reserve) {
      // A2-12 — suppression REJOUÉE. Le mobile renvoie la suppression quand la
      // réponse s'est perdue ; « introuvable » passait pour un refus définitif,
      // le mobile restaurait la réserve depuis son instantané — un fantôme — et
      // la tâche restait en échec pour toujours. Une réserve DÉJÀ supprimée
      // dans CETTE organisation est un succès sans effet ; toute autre absence
      // reste « introuvable » (jamais de confirmation hors organisation).
      const supprimee = await Reserve.findOne({
        where: { id: reserveId },
        paranoid: false,
        include: [{ model: Chantier, as: 'chantier', attributes: ['organisationId'], paranoid: false }],
      });
      if (supprimee?.deletedAt && supprimee.chantier?.organisationId === organisationId) {
        return { success: true, message: 'Réserve déjà supprimée', rejeu: true };
      }
      return { success: false, message: 'Réserve introuvable dans cette organisation' };
    }

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
