'use strict';

const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { Plan, Chantier, Annotation, Reserve, ReservePosition, Media, Organisation, Zone, Etage, Batiment, PlanHotspot, Utilisateur } = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');
const nomFichierOriginal = require('../../../utils/nomFichierUpload.js');
const { OPERATIONNEL_CONTROLE } = require('../../../config/roles.js');

// ══════════════════════════════════════════════════════════════════════════════
//  VERSIONNEMENT DES PLANS (audit § 6)
//
//  L'ancien code faisait `findOne(order: version DESC)` puis `version + 1`,
//  sans verrou ni contrainte d'unicité. Deux défauts :
//    1. course : deux uploads simultanés du même plan lisaient la même
//       dernière version et créaient tous deux la version 3 — silencieusement,
//       puisque rien en base ne l'interdisait ;
//    2. Plan est paranoid : `findOne` excluait les versions supprimées, donc
//       supprimer la dernière version faisait RÉUTILISER son numéro, et deux
//       fichiers différents portaient la même référence de plan (les réserves
//       étant censées rester liées à « la version sur laquelle elles ont été
//       posées », c'est une perte d'intégrité documentaire).
//
//  Correction (même logique que la numérotation des réserves) :
//    - verrou consultatif Postgres porté par la transaction, qui sérialise le
//      calcul du numéro de version pour un couple (chantier, nom) ;
//    - MAX calculé avec `paranoid: false`, donc sur les mêmes lignes que
//      l'index unique (Postgres indexe aussi les lignes soft-deleted) ;
//    - index unique `plans_chantier_nom_version_unique` ajouté par migration —
//      dernier rempart : une collision devient une erreur, plus un doublon ;
//    - réessai en filet pour les écritures qui n'auraient pas pris le verrou.
// ══════════════════════════════════════════════════════════════════════════════

/** Sérialise le calcul de version d'un plan pour la durée de la transaction. */
async function _verrouillerVersion(chantierId, nom, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle)) AS verrou', {
    replacements: { cle: `plan:version:${chantierId}:${nom}` },
    type: QueryTypes.SELECT,
    transaction,
  });
}

/** Vrai si l'erreur est une collision sur (chantier, nom, version). */
function _estCollisionVersion(err) {
  if (!(err instanceof UniqueConstraintError)) return false;
  const contrainte = (err.parent && err.parent.constraint) || '';
  const champs = Object.keys(err.fields || {}).join(',');
  return `${contrainte} ${champs}`.includes('version');
}

async function _avecReessaiVersion(operation, tentatives = 3) {
  for (let essai = 1; ; essai += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!_estCollisionVersion(err) || essai >= tentatives) throw err;
      logger.warn(`[plan] Collision de version détectée — réessai ${essai}/${tentatives - 1}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOCALISATION D'UN PLAN
//
//  Un plan porte `zoneId` (l'appartement / la pièce). Le parcours décrit par le
//  guide client — « plan global → bâtiment → étage → appartement » — a besoin
//  de la chaîne COMPLÈTE pour ranger chaque plan à son niveau : sans elle, le
//  client ne peut pas savoir qu'un plan appartient au 2e étage du bâtiment A,
//  et devait recharger toute la structure du chantier puis la recouper à la
//  main.
//
//  `required: false` partout : un plan sans zone est le PLAN GLOBAL du
//  chantier (ou d'un bâtiment). Il doit continuer d'apparaître dans la liste —
//  c'est même le point d'entrée du parcours.
// ══════════════════════════════════════════════════════════════════════════════
const INCLUDE_LOCALISATION = [
  {
    model: Zone,
    as: 'zone',
    required: false,
    attributes: ['id', 'nom', 'type'],
    include: [{
      model: Etage,
      as: 'etage',
      required: false,
      attributes: ['id', 'nom', 'niveau'],
      include: [{ model: Batiment, as: 'batiment', required: false, attributes: ['id', 'nom', 'code'] }],
    }],
  },
  // Rattachements DIRECTS — un plan d'étage n'a pas de zone, un plan de
  // bâtiment n'a ni zone ni étage : sans ces deux jointures, ces plans
  // arrivaient au client sans aucune localisation et se retrouvaient tous
  // rangés au niveau du chantier.
  {
    model: Etage,
    as: 'etage',
    required: false,
    attributes: ['id', 'nom', 'niveau'],
    include: [{ model: Batiment, as: 'batiment', required: false, attributes: ['id', 'nom', 'code'] }],
  },
  { model: Batiment, as: 'batiment', required: false, attributes: ['id', 'nom', 'code'] },
];

/**
 * Dossier de stockage d'un plan — cahier technique § 5.
 *
 * Le document décrit une arborescence :
 *
 * ```
 * plans/projet_{id}/batiment_A/sous_sol_-3/
 * ```
 *
 * Tout partait jusqu'ici dans un `plans/` unique. Sur un bucket qui finit par
 * porter des milliers de fichiers, plus rien ne se retrouve à la main : ni
 * pour un export, ni pour une restauration ciblée, ni pour répondre à un
 * client qui réclame « les plans du bâtiment B ».
 *
 * ── Assainissement des noms ───────────────────────────────────────────────
 *
 * Les noms de bâtiment et de niveau sont SAISIS PAR L'UTILISATEUR : « Bât. A /
 * Sous-sol -3 », avec accents, espaces, points et barres obliques. Une barre
 * oblique créerait un niveau de dossier fantôme, et un `..` remonterait dans
 * l'arborescence. On ne garde donc que des caractères sûrs.
 *
 * Le nom assaini peut devenir vide (un niveau nommé « / » ou « ... ») : on
 * retombe alors sur l'identifiant, qui est toujours exploitable.
 */
function _segmentSur(valeur, repli) {
  const brut = String(valeur || '').trim();
  const assaini = brut
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // accents
    .replace(/[^A-Za-z0-9._+-]+/g, '_') // tout le reste devient un souligné
    .replace(/^[._-]+|[._-]+$/g, '')    // pas de point ni tiret aux extrémités
    .slice(0, 60);
  return assaini || String(repli || '').slice(0, 60) || 'inconnu';
}

/**
 * `plans/projet_{id}/batiment_X/niveau_Y/` — le plus précis que l'on connaisse.
 *
 * Un plan global n'a ni bâtiment ni niveau : il se range directement sous son
 * projet. C'est voulu — inventer un dossier « batiment_aucun » ne rangerait
 * rien, cela ajouterait un cran vide à traverser.
 */
async function _dossierDuPlan(chantierId, rattachement) {
  const segments = [`projet_${chantierId}`];

  if (rattachement.batimentId) {
    const batiment = await Batiment.findByPk(rattachement.batimentId, { attributes: ['id', 'nom'] });
    segments.push(`batiment_${_segmentSur(batiment && batiment.nom, rattachement.batimentId)}`);
  }
  if (rattachement.etageId) {
    const etage = await Etage.findByPk(rattachement.etageId, { attributes: ['id', 'nom'] });
    segments.push(`niveau_${_segmentSur(etage && etage.nom, rattachement.etageId)}`);
  }
  if (rattachement.zoneId) {
    const zone = await Zone.findByPk(rattachement.zoneId, { attributes: ['id', 'nom'] });
    segments.push(`zone_${_segmentSur(zone && zone.nom, rattachement.zoneId)}`);
  }

  return `plans/${segments.join('/')}`;
}

/**
 * Statuts d'une réserve LEVÉE — la règle du rapport (`rapport.service.js`) et
 * du tableau de bord : validée ou clôturée. Tout le reste — créée, affectée,
 * en cours, refusée, rouverte, en retard… — reste à traiter.
 */
const STATUTS_LEVES = ['validee', 'cloturee'];

/**
 * Compte, pour une liste de plans, les nombres dont la navigation par niveau
 * a besoin : combien de sous-plans directs, combien de réserves posées, et
 * combien de celles-ci restent À TRAITER.
 *
 * ── Pourquoi « à traiter » à côté du total ────────────────────────────────
 *
 * Le total seul alarme pour rien : un appartement dont les dix réserves sont
 * levées afficherait « 10 réserves », comme celui où tout reste à faire. Les
 * deux nombres sortent de la MÊME requête (`COUNT(*) FILTER`), sans
 * aller-retour de plus.
 *
 * ── Par VERSION ───────────────────────────────────────────────────────────
 *
 * Une réserve appartient à la version sur laquelle elle a été posée : un
 * nouveau dépôt ne la déplace pas (`deposerVersion`). Chaque version porte
 * donc SES compteurs — ceux de la version courante sont exactement les
 * repères qu'on voit en l'ouvrant.
 *
 * ── Pourquoi le serveur, et pas le client ─────────────────────────────────
 *
 * Le mobile ne charge plus tous les plans du chantier d'un coup : il descend
 * niveau par niveau, et ne connaît donc à aucun moment l'arborescence
 * complète. Sans ces deux compteurs, il ne saurait pas si une tuile mène
 * quelque part — et devrait ouvrir chaque plan pour l'apprendre.
 *
 * ── Deux agrégats, pas N+1 requêtes ───────────────────────────────────────
 *
 * Un `COUNT` par plan affiché mettrait vingt allers-retours sur une liste de
 * vingt plans. Les deux requêtes ci-dessous répondent pour toute la page.
 *
 * SQL brut plutôt que `Model.count({ group })` : les modèles sont
 * `underscored`, et le nom de colonne à grouper (`parent_id`, `plan_id`) est
 * alors le seul qui soit certain. `deleted_at IS NULL` reproduit le
 * `paranoid` des deux modèles — un plan supprimé ne doit pas être compté.
 */
async function _compterEnfants(plans) {
  if (!Array.isArray(plans) || plans.length === 0) return plans;
  const ids = plans.map((p) => p.id);

  const [sousPlans, reserves] = await Promise.all([
    sequelize.query(
      'SELECT parent_id AS "planId", COUNT(*)::int AS total FROM plans '
      + 'WHERE deleted_at IS NULL AND parent_id IN (:ids) GROUP BY parent_id',
      { replacements: { ids }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      'SELECT plan_id AS "planId", COUNT(*)::int AS total, '
      + 'COUNT(*) FILTER (WHERE statut NOT IN (:leves))::int AS "aTraiter" FROM reserves '
      + 'WHERE deleted_at IS NULL AND plan_id IN (:ids) GROUP BY plan_id',
      { replacements: { ids, leves: STATUTS_LEVES }, type: QueryTypes.SELECT }
    ),
  ]);

  const parPlan = (lignes, champ = 'total') =>
    new Map(lignes.map((l) => [String(l.planId), Number(l[champ]) || 0]));
  const nbSousPlans = parPlan(sousPlans);
  const nbReserves = parPlan(reserves);
  const nbATraiter = parPlan(reserves, 'aTraiter');

  for (const plan of plans) {
    plan.dataValues.nombre_sous_plans = nbSousPlans.get(String(plan.id)) || 0;
    plan.dataValues.nombre_reserves = nbReserves.get(String(plan.id)) || 0;
    plan.dataValues.nombre_reserves_a_traiter = nbATraiter.get(String(plan.id)) || 0;
  }
  return plans;
}

/**
 * Ne garde que la version COURANTE de chaque plan.
 *
 * Un plan versionné apparaît autant de fois qu'il a été redéposé. Dans une
 * navigation par niveau, cela ferait apparaître le même appartement trois
 * fois dans la même liste, sans qu'aucune des trois tuiles ne dise laquelle
 * est la bonne. L'historique reste accessible par `listVersions`.
 *
 * ── `is_current` d'abord, le plus grand numéro en repli ───────────────────
 *
 * Le cahier technique (§ 10, § 15) demande une version courante DÉSIGNÉE, pas
 * déduite : `is_current = true`. C'est ce qui permettra de garder active une
 * version antérieure pendant qu'une nouvelle est contrôlée, sans déplacer
 * automatiquement les réserves.
 *
 * Le repli sur le plus grand numéro reste indispensable : il couvre les
 * secondes qui séparent le déploiement du code de l'exécution de la migration,
 * et tout jeu de données où le drapeau n'aurait pas été posé. Sans lui, une
 * liste répondrait VIDE — un écran vide pour un chantier plein de plans est le
 * pire résultat possible.
 *
 * Suppose la liste déjà triée par (nom ASC, version DESC) — c'est l'ordre de
 * toutes les requêtes de ce service.
 */
function _derniereVersion(plans) {
  const courants = plans.filter((p) => p.is_current === true);
  const source = courants.length > 0 ? courants : plans;

  const vus = new Set();
  return source.filter((p) => {
    const cle = `${p.chantierId}:${p.nom}`;
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/** Zones cliquables du plan — voir planHotspot.model.js. */
const INCLUDE_HOTSPOTS = {
  model: PlanHotspot,
  as: 'hotspots',
  required: false,
  attributes: ['id', 'cible_type', 'cible_id', 'libelle', 'x', 'y', 'largeur', 'hauteur', 'page'],
};

/**
 * Vérifie que le niveau auquel on rattache le plan appartient bien AU chantier
 * visé, et renvoie le triplet à enregistrer.
 *
 * Sans ce contrôle, `batimentId` / `etageId` / `zoneId` étant de simples UUID
 * dans le corps de la requête, un utilisateur pouvait ranger son plan sous le
 * bâtiment d'un autre chantier — voire d'une autre organisation. Le plan
 * apparaissait alors dans une arborescence qui ne lui appartenait pas.
 *
 * Les trois niveaux sont EXCLUSIFS : on retient le plus fin renseigné et on
 * ignore les autres, plutôt que de rejeter l'upload. Un client qui envoie à la
 * fois l'étage et l'appartement décrit l'appartement ; refuser le fichier pour
 * cette redondance ferait perdre le dépôt sans rien protéger.
 */
async function _resoudreRattachement(chantierId, data) {
  const vide = { batimentId: null, etageId: null, zoneId: null };

  // ── Plan de DÉTAIL : il hérite de la place de son parent ────────────────
  //
  // C'est ce qui empêche `parentId` de devenir une seconde hiérarchie
  // concurrente. Le plan d'une pièce est rattaché au même appartement, au même
  // étage et au même bâtiment que le plan dont il est le détail : une réserve
  // posée dessus reste donc localisée là où elle est réellement, ce dont
  // dépendent les rapports, les filtres et le tableau de bord.
  //
  // Le rattachement éventuellement envoyé par le client est IGNORÉ dans ce
  // cas : deux places contradictoires pour un même plan seraient impossibles à
  // arbitrer plus tard.
  if (data.parentId) {
    const parent = await Plan.findOne({
      where: { id: data.parentId, chantierId },
      attributes: ['id', 'batimentId', 'etageId', 'zoneId'],
    });
    if (!parent) return { erreur: 'Le plan parent n’appartient pas à ce chantier' };
    return {
      parentId: parent.id,
      batimentId: parent.batimentId,
      etageId: parent.etageId,
      zoneId: parent.zoneId,
    };
  }

  if (data.zoneId) {
    const zone = await Zone.findByPk(data.zoneId, {
      attributes: ['id', 'etageId'],
      include: [{
        model: Etage, as: 'etage', attributes: ['id', 'batimentId'], required: true,
        include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true }],
      }],
    });
    if (!zone) return { erreur: 'La zone indiquée n’appartient pas à ce chantier' };
    return { ...vide, parentId: null, zoneId: zone.id, etageId: zone.etageId, batimentId: zone.etage.batimentId };
  }

  if (data.etageId) {
    const etage = await Etage.findByPk(data.etageId, {
      attributes: ['id', 'batimentId'],
      include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true }],
    });
    if (!etage) return { erreur: 'L’étage indiqué n’appartient pas à ce chantier' };
    return { ...vide, parentId: null, etageId: etage.id, batimentId: etage.batimentId };
  }

  if (data.batimentId) {
    const batiment = await Batiment.findOne({ where: { id: data.batimentId, chantierId }, attributes: ['id'] });
    if (!batiment) return { erreur: 'Le bâtiment indiqué n’appartient pas à ce chantier' };
    return { ...vide, parentId: null, batimentId: batiment.id };
  }

  // Aucun rattachement : plan global du chantier — le point d'entrée du parcours.
  return { ...vide, parentId: null };
}

class PlanService {

  /**
   * Où ce plan se rattache-t-il ? Exposé pour être testé directement.
   *
   * C'est la règle qui empêche `parentId` de devenir une seconde hiérarchie
   * concurrente de la structure — elle mérite d'être vérifiée sans monter tout
   * un dépôt de fichier. Même parti pris que
   * `ChantierService.filtreCloisonnement`.
   */
  static _resoudreRattachement(chantierId, data) {
    return _resoudreRattachement(chantierId, data);
  }

  /**
   * Ce compte a-t-il le droit de déposer un plan sur ce chantier ?
   *
   * La route laisse passer `DEPOSANT` pour ouvrir le parcours « Envoi Plan » à
   * l'entreprise. Ce serait trop large sans cette garde : l'entreprise pourrait
   * déposer des plans sur N'IMPORTE QUEL chantier en activité de l'organisation.
   *
   * La règle tient en une phrase : hors OPERATIONNEL_CONTROLE (et hors
   * super-admin), on ne dépose que sur SA PROPRE demande encore en attente.
   * Une fois le chantier validé, les autorisations redeviennent celles d'avant.
   *
   * @returns {string|null} Message de refus, ou `null` si le dépôt est permis.
   */
  static _refusDepot(chantier, auteur) {
    // Pas d'auteur identifié : appels internes (duplication, amorçage). La garde
    // ne s'applique qu'aux dépôts venus d'une requête.
    if (!auteur || !auteur.role) return null;
    if (auteur.role === 'Admin' || OPERATIONNEL_CONTROLE.includes(auteur.role)) return null;
  
    if (chantier.statut !== 'en_attente_validation') {
      return 'Vous ne pouvez déposer des plans que sur une demande de chantier en attente de validation.';
    }
    if (String(chantier.demandeurId) !== String(auteur.id)) {
      return 'Vous ne pouvez déposer des plans que sur vos propres demandes de chantier.';
    }
    return null;
  }

  // -------------------- UPLOAD D'UN PLAN --------------------
  /**
   * Enregistre un plan avec versionning : si un plan du même nom existe
   * déjà sur le chantier, la version suivante est créée (les réserves
   * restent liées à la version sur laquelle elles ont été posées).
   */
  /**
   * Dépôt d'un plan.
   *
   * @param {object} [auteur]  Compte appelant, issu du jeton. Sert à la garde
   *   fine du parcours « Envoi Plan » — voir `_refusDepot`.
   */
  static async upload(organisationId, chantierId, data, fichier, auteur = null) {
    if (!fichier || !fichier.buffer) {
      return { success: false, message: 'Fichier plan manquant' };
    }

    // Isolation multi-tenant : sans ce contrôle, un utilisateur authentifié
    // pouvait déposer un plan dans le chantier d'une autre organisation en
    // changeant simplement :chantierId dans l'URL.
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const refus = PlanService._refusDepot(chantier, auteur);
    if (refus) return { success: false, message: refus };

    // Un plan joint à une demande attend la MÊME validation que son chantier.
    // Sans cela, il serait indiscernable d'un plan validé et des équipes y
    // poseraient des réserves sur un chantier qui n'existe pas encore.
    const statutPlan = chantier.statut === 'en_attente_validation'
      ? 'en_attente_validation'
      : 'actif';

    // Rattachement résolu AVANT l'écriture disque : un rattachement invalide
    // doit échouer sans avoir rien déposé sur le disque.
    const rattachement = await _resoudreRattachement(chantierId, data);
    if (rattachement.erreur) return { success: false, message: rattachement.erreur };

    // Écriture disque AVANT la transaction (I/O non transactionnelle). Si
    // l'enregistrement en base échoue malgré tout, le fichier orphelin est
    // effacé en best-effort — sans quoi chaque erreur laissait un fichier
    // téléchargeable indéfiniment (audit § 5).
    // Rangé sous son projet, son bâtiment et son niveau (cahier § 5) plutôt
    // que dans un `plans/` unique où plus rien ne se retrouve à la main.
    const dossier = await _dossierDuPlan(chantierId, rattachement);
    const fichier_url = await storeFile(fichier.buffer, fichier.originalname, dossier);

    try {
      const plan = await _avecReessaiVersion(async () => {
        const t = await sequelize.transaction();
        try {
          await _verrouillerVersion(chantierId, data.nom, t);

          // paranoid: false — l'index unique compte les versions supprimées,
          // le calcul doit voir exactement les mêmes lignes.
          const max = await Plan.max('version', {
            where: { chantierId, nom: data.nom },
            paranoid: false,
            transaction: t,
          });
          const version = (Number(max) || 0) + 1;

          const cree = await Plan.create({
            chantierId,
            batimentId: rattachement.batimentId,
            etageId: rattachement.etageId,
            zoneId: rattachement.zoneId,
            parentId: rattachement.parentId,
            nom: data.nom,
            version,
            fichier_url,
            format: data.format || 'pdf',
            // Discipline et date DU PLAN — cahier technique § 4.
            type_plan: data.type_plan || null,
            date_plan: data.date_plan || null,
            page_count: data.page_count || null,
            // Accents rétablis — multer lit le nom en latin1 (utils/nomFichierUpload.js).
            fichier_nom: fichier.originalname ? nomFichierOriginal(fichier.originalname) : null,
            uploaderId: data.uploaderId || null,
            statut: statutPlan,
            // Le nouveau dépôt devient la version courante (cahier § 15).
            is_current: true,
          }, { transaction: t });

          // ...et les précédentes cessent de l'être.
          //
          // DANS LA MÊME TRANSACTION que la création : deux versions courantes
          // simultanées feraient apparaître le même plan deux fois dans chaque
          // liste, sans que rien ne dise laquelle est la bonne. Le verrou pris
          // plus haut sérialise déjà les dépôts d'un même plan.
          await Plan.update(
            { is_current: false },
            {
              where: {
                chantierId,
                nom: data.nom,
                id: { [Op.ne]: cree.id },
              },
              transaction: t,
            },
          );

          await t.commit();
          return cree;
        } catch (err) {
          await t.rollback();
          throw err;
        }
      });

      return { success: true, message: 'Plan importé avec succès', plan };
    } catch (err) {
      await deleteFile(fichier_url).catch(() => {});
      throw err;
    }
  }

  // -------------------- LISTER LES PLANS D'UN CHANTIER --------------------
  static async listPlans(organisationId, chantierId) {
    // Isolation multi-tenant : le chantier doit appartenir à l'organisation
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const plans = await Plan.findAll({
      where: { chantierId },
      include: [...INCLUDE_LOCALISATION, INCLUDE_HOTSPOTS],
      order: [['nom', 'ASC'], ['version', 'DESC']],
    });
    // Les compteurs de réserves — « 5 réserves · 2 à traiter » — que le mobile
    // affiche à côté de chaque plan de l'arborescence du plan global. Deux
    // agrégats pour toute la liste, jamais une requête par plan.
    await _compterEnfants(plans);
    return { success: true, plans };
  }

  // -------------------- PLANS GLOBAUX D'UN CHANTIER --------------------
  /**
   * Les plans de PREMIER NIVEAU du chantier — ceux qui n'ont pas de parent.
   *
   * ── Pourquoi une route à part de `listPlans` ──────────────────────────────
   *
   * `listPlans` renvoie l'arborescence À PLAT : plans globaux, plans de
   * bâtiment, plans d'étage et plans de détail dans la même liste. C'est ce
   * qu'il faut à l'écran « tous les documents du chantier » ; c'est exactement
   * ce qu'il ne faut pas au parcours de relevé, où l'utilisateur doit descendre
   * un niveau à la fois et ne voir, à chaque étape, que les enfants DIRECTS du
   * plan ouvert.
   *
   * Le point d'entrée de cette descente, c'est ici : `parentId IS NULL`.
   * `GET /plans/:id/sous-plans` prend le relais à tous les crans suivants — les
   * deux routes renvoient la même forme d'objet, compteurs compris, pour que le
   * client n'ait qu'un seul rendu de tuile à écrire.
   *
   * Une seule version par plan (la plus récente) : voir `_derniereVersion`.
   */
  static async listPlansRacines(organisationId, chantierId) {
    // Isolation multi-tenant : le chantier doit appartenir à l'organisation.
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const plans = _derniereVersion(await Plan.findAll({
      where: { chantierId, parentId: null },
      include: [...INCLUDE_LOCALISATION, INCLUDE_HOTSPOTS],
      order: [['nom', 'ASC'], ['version', 'DESC']],
    }));
    await _compterEnfants(plans);
    return { success: true, plans };
  }

  // -------------------- SOUS-PLANS DIRECTS D'UN PLAN --------------------
  /**
   * Les plans de DÉTAIL rattachés directement à ce plan — jamais leurs propres
   * détails.
   *
   * La navigation est progressive : à chaque niveau on n'affiche que les
   * enfants directs du plan ouvert. Renvoyer l'arborescence entière obligerait
   * le client à la filtrer, et ferait grossir la réponse avec des plans que
   * personne ne regarde encore.
   *
   * Le cloisonnement passe par le PARENT : on vérifie d'abord que le plan
   * appelé appartient bien à un chantier de l'organisation, jamais l'inverse.
   * Sans cela, un identifiant deviné donnerait les plans d'un autre client.
   */
  static async listSousPlans(organisationId, planId) {
    const parent = await Plan.findOne({
      where: { id: planId },
      attributes: ['id', 'chantierId'],
      include: [{
        model: Chantier, as: 'chantier', attributes: ['id'],
        where: { organisationId }, required: true,
      }],
    });
    if (!parent) return { success: false, message: 'Plan introuvable' };

    const sousPlans = _derniereVersion(await Plan.findAll({
      where: { parentId: parent.id },
      include: [...INCLUDE_LOCALISATION, INCLUDE_HOTSPOTS],
      order: [['nom', 'ASC'], ['version', 'DESC']],
    }));
    // Chaque tuile doit dire si elle mène plus bas et combien de réserves elle
    // porte, SANS que le client ait à ouvrir le plan pour l'apprendre.
    await _compterEnfants(sousPlans);
    return { success: true, sousPlans };
  }

  // -------------------- LISTER TOUS LES PLANS DE L'ORGANISATION --------------------
  /**
   * Liste transversale (tous chantiers confondus) — alimente l'onglet « Plans »
   * du mobile, écran de premier niveau. Ne renvoie que la DERNIÈRE version de
   * chaque plan : un utilisateur qui ouvre « Plans » cherche le document
   * courant, pas l'historique des révisions (celui-ci reste accessible par
   * `listVersions`). Le tri par (nom, version DESC) puis le dédoublonnage sur
   * (chantierId, nom) suffit — pas de sous-requête à écrire.
   */
  /**
   * @param {object} [options]
   * @param {boolean} [options.toutesOrganisations]  Ignore le filtre par
   *   organisation. RÉSERVÉ au super-admin plateforme, qui n'en a pas : sans
   *   cela l'onglet « Plans » lui répondait toujours vide, la jointure filtrant
   *   sur son propre `organisationId` — c'est-à-dire `null`. Posé par le
   *   contrôleur d'après le rôle, JAMAIS d'après un paramètre de requête.
   */
  static async listTousPlans(organisationId, { chantierId } = {}, { toutesOrganisations = false, auteur = null } = {}) {
    const where = {};
    if (chantierId) where.chantierId = chantierId;

    // Filtre facultatif quand le super-admin cible une organisation précise.
    const whereChantier = {};
    if (!toutesOrganisations || organisationId) whereChantier.organisationId = organisationId;

    // Même visibilité que la liste des chantiers. Require local : le service
    // des chantiers dépend lui-même de modules qui chargent celui-ci.
    // eslint-disable-next-line global-require
    const cloisonnement = require('../../chantier/service/chantier.service.js').filtreCloisonnement(auteur);
    if (cloisonnement) Object.assign(whereChantier, cloisonnement);

    const plans = await Plan.findAll({
      where,
      include: [
        ...INCLUDE_LOCALISATION,
        INCLUDE_HOTSPOTS,
        // `required: true` : c'est CE filtre qui porte l'isolation multi-tenant.
        {
          model: Chantier, as: 'chantier', where: whereChantier, required: true, attributes: ['id', 'nom', 'code'],
          // L'organisation propriétaire : dans la vue « toutes organisations »
          // du super-admin, rien ne distingue sinon deux chantiers homonymes
          // appartenant à deux clients différents.
          include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'] }],
        },
      ],
      order: [['nom', 'ASC'], ['version', 'DESC']],
    });

    const vus = new Set();
    const derniereVersion = plans.filter((p) => {
      const cle = `${p.chantierId}:${p.nom}`;
      if (vus.has(cle)) return false;
      vus.add(cle);
      return true;
    });

    return { success: true, plans: derniereVersion };
  }

  // -------------------- LISTER LES VERSIONS D'UN PLAN --------------------
  /**
   * Retourne toutes les versions d'un même plan (comparaison des versions).
   * Les réserves restent liées à la version sur laquelle elles ont été posées.
   */
  static async listVersions(organisationId, planId) {
    const plan = await Plan.findByPk(planId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const versions = await Plan.findAll({
      where: { chantierId: plan.chantierId, nom: plan.nom },
      order: [['version', 'ASC']],
    });
    return { success: true, plan, versions };
  }

  // -------------------- DÉTAIL D'UN PLAN --------------------
  /**
   * Le détail sert à AFFICHER le plan avec ses repères : les réserves posées
   * dessus sont donc jointes ici, avec leur position (x, y). Sans elles, le
   * client devrait lister toutes les réserves du chantier puis filtrer sur
   * `planId` côté mobile — un aller-retour inutile et une liste bien plus
   * lourde que nécessaire.
   *
   * `ReservePosition` est en `required: false` : une réserve peut être
   * rattachée à un plan sans coordonnées (créée depuis la liste et non depuis
   * le plan). Elle est renvoyée quand même — c'est au client de décider s'il
   * l'affiche comme repère ou seulement dans la liste latérale.
   */
  static async getPlan(planId, organisationId) {
    const plan = await Plan.findByPk(planId, {
      include: [
        // Scoping multi-tenant : le chantier doit appartenir à l'organisation
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom'] },
        ...INCLUDE_LOCALISATION,
        INCLUDE_HOTSPOTS,
      ],
    });
    if (!plan || !plan.chantier) {
      return { success: false, message: 'Plan introuvable dans cette organisation' };
    }

    const reserves = await Reserve.findAll({
      where: { planId },
      // `description` et `created_at` en plus : la fiche qui s'ouvre au clic
      // sur un repère doit montrer CE QUI A ÉTÉ SAISI à la création. Sans la
      // description, elle n'affichait qu'un titre et un badge — et le seul
      // moyen de lire l'observation était de quitter le plan.
      // Les champs que la FICHE ouverte au clic sur un repère affiche.
      //
      // Rien de plus que ce que le modèle porte déjà : titre, observation,
      // statut, gravité, échéance, dates de création et de dernière
      // modification. Ils tiennent en une requête, et les charger ici évite un
      // aller-retour par réserve au moment où l'utilisateur appuie sur un
      // point — geste qu'il répète sur chaque repère du plan.
      attributes: [
        'id', 'numero', 'titre', 'description', 'statut', 'severite',
        'date_limite', 'createdAt', 'updatedAt',
      ],
      include: [
        { model: ReservePosition, as: 'position', required: false },
        // L'AUTEUR du constat : « qui a relevé ça ? » est la question qui suit
        // immédiatement « qu'est-ce que c'est ? ». Le mot de passe et le reste
        // du compte ne sortent jamais — trois colonnes, pas une de plus.
        {
          model: Utilisateur,
          as: 'createur',
          required: false,
          attributes: ['id', 'nom', 'prenom'],
        },
        { model: Media, as: 'medias', attributes: ['id', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [['numero', 'ASC']],
    });
    plan.dataValues.reserves = reserves;

    // Le détail est aussi le point d'où l'on descend d'un cran : le client doit
    // savoir s'il y a quelque chose SOUS ce plan avant d'appeler
    // `/plans/:id/sous-plans`, ne serait-ce que pour ne pas afficher une
    // section « Sous-plans » vide.
    plan.dataValues.nombre_sous_plans = await Plan.count({ where: { parentId: plan.id } });
    plan.dataValues.nombre_reserves = reserves.length;

    return { success: true, plan };
  }

  // -------------------- PLAN DE RÉFÉRENCE D'UNE VERSION --------------------
  /**
   * Le plan désigné, avec ce qu'il faut pour en déposer une nouvelle version.
   *
   * Cloisonné par le CHANTIER, comme toutes les lectures de ce module : un
   * identifiant deviné ne doit pas permettre de verser un fichier dans le
   * dossier d'un autre client.
   */
  static async getPlanPourVersion(organisationId, planId) {
    const plan = await Plan.findOne({
      where: { id: planId },
      attributes: ['id', 'chantierId', 'nom', 'batimentId', 'etageId', 'zoneId', 'parentId', 'type_plan'],
      include: [{
        model: Chantier, as: 'chantier', attributes: ['id'],
        where: { organisationId }, required: true,
      }],
    });
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };
    return { success: true, plan };
  }

  // -------------------- RÉSERVES D'UN PLAN --------------------
  /**
   * Les réserves posées sur CE plan — cahier technique § 11,
   * `GET /api/plans/{planId}/reserves`.
   *
   * ── Pourquoi une route à part, alors que le détail les porte déjà ────────
   *
   * `getPlan` renvoie le plan ET ses réserves : c'est ce qu'il faut à
   * l'ouverture. Mais après avoir posé une réserve, le client n'a besoin que
   * des repères — pas de re-télécharger la fiche du plan, ses zones cliquables
   * et sa localisation complète. Le cahier prévoit d'ailleurs les deux appels.
   *
   * Le cloisonnement passe par le PLAN, jamais par un `chantierId` fourni par
   * l'appelant : on vérifie d'abord que le plan appartient à un chantier de
   * l'organisation, et les réserves en découlent.
   */
  static async listReservesDuPlan(organisationId, planId) {
    const plan = await Plan.findOne({
      where: { id: planId },
      attributes: ['id'],
      include: [{
        model: Chantier, as: 'chantier', attributes: ['id'],
        where: { organisationId }, required: true,
      }],
    });
    if (!plan) return { success: false, message: 'Plan introuvable' };

    const reserves = await Reserve.findAll({
      where: { planId },
      // Mêmes champs que le détail du plan : les deux routes alimentent le
      // MÊME rendu de repère et la même fiche. Les faire diverger obligerait
      // le client à savoir de laquelle vient sa donnée.
      attributes: [
        'id', 'numero', 'titre', 'description', 'statut', 'severite',
        'date_limite', 'createdAt', 'updatedAt',
      ],
      include: [
        { model: ReservePosition, as: 'position', required: false },
        { model: Utilisateur, as: 'createur', required: false, attributes: ['id', 'nom', 'prenom'] },
        { model: Media, as: 'medias', attributes: ['id', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [['numero', 'ASC']],
    });

    return { success: true, reserves };
  }

  // -------------------- SUPPRIMER UN PLAN --------------------
  /**
   * Suppression d'un plan.
   *
   * DÉCISION (audit § 5) — fichier sur disque vs soft delete :
   *   - suppression NORMALE (`definitif = false`) : soft delete. Le plan est
   *     restaurable, ses annotations et les réserves qui y pointent aussi : le
   *     FICHIER EST CONSERVÉ. Effacer le fichier ici rendrait le `restore()`
   *     mensonger (ligne restaurée, document introuvable). Il reste hors de
   *     portée de l'API, puisque tout accès passe par une ligne non supprimée.
   *   - PURGE définitive (`definitif = true`) : la ligne quitte la base, plus
   *     rien ne référencera jamais le fichier → il est effacé du disque en
   *     best-effort (deleteFile ne doit jamais faire échouer l'action métier).
   */
  static async supprimerPlan(organisationId, planId, definitif = false) {
    // Isolation multi-tenant : le chantier doit appartenir à l'organisation
    const plan = await Plan.findByPk(planId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      paranoid: !definitif, // une purge doit aussi pouvoir viser un plan déjà soft-deleted
    });
    if (!plan) return { success: false, message: 'Plan introuvable dans cette organisation' };

    const urlFichier = plan.fichier_url;

    const t = await sequelize.transaction();
    try {
      // Les annotations ne disparaissent pas toutes seules : `onDelete: CASCADE`
      // ne se déclenche pas sur un soft delete (audit § 4).
      await Annotation.destroy({ where: { planId }, force: definitif, transaction: t });
      await plan.destroy({ force: definitif, transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    if (definitif) {
      // Best-effort APRÈS commit : le fichier n'est plus référencé par personne.
      await deleteFile(urlFichier).catch((err) =>
        logger.warn(`[plan] Fichier non supprimé du disque : ${err.message}`)
      );
    }

    return {
      success: true,
      message: definitif ? 'Plan supprimé définitivement' : 'Plan supprimé',
    };
  }
}

module.exports = PlanService;
