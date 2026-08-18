'use strict';

const { QueryTypes, UniqueConstraintError } = require('sequelize');
const { Plan, Chantier, Annotation, Reserve, ReservePosition, Media } = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const { storeFile, deleteFile } = require('../../../infrastructure/storage.service.js');

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

class PlanService {

  // -------------------- UPLOAD D'UN PLAN --------------------
  /**
   * Enregistre un plan avec versionning : si un plan du même nom existe
   * déjà sur le chantier, la version suivante est créée (les réserves
   * restent liées à la version sur laquelle elles ont été posées).
   */
  static async upload(organisationId, chantierId, data, fichier) {
    if (!fichier || !fichier.buffer) {
      return { success: false, message: 'Fichier plan manquant' };
    }

    // Isolation multi-tenant : sans ce contrôle, un utilisateur authentifié
    // pouvait déposer un plan dans le chantier d'une autre organisation en
    // changeant simplement :chantierId dans l'URL.
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Écriture disque AVANT la transaction (I/O non transactionnelle). Si
    // l'enregistrement en base échoue malgré tout, le fichier orphelin est
    // effacé en best-effort — sans quoi chaque erreur laissait un fichier
    // téléchargeable indéfiniment (audit § 5).
    const fichier_url = await storeFile(fichier.buffer, fichier.originalname, 'plans');

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
            zoneId: data.zoneId || null,
            nom: data.nom,
            version,
            fichier_url,
            format: data.format || 'pdf',
            page_count: data.page_count || null,
            fichier_nom: fichier.originalname || null,
            uploaderId: data.uploaderId || null,
          }, { transaction: t });

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
      order: [['nom', 'ASC'], ['version', 'DESC']],
    });
    return { success: true, plans };
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
  static async listTousPlans(organisationId, { chantierId } = {}) {
    const where = {};
    if (chantierId) where.chantierId = chantierId;

    const plans = await Plan.findAll({
      where,
      include: [
        // `required: true` : c'est CE filtre qui porte l'isolation multi-tenant.
        { model: Chantier, as: 'chantier', where: { organisationId }, required: true, attributes: ['id', 'nom', 'code'] },
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
      ],
    });
    if (!plan || !plan.chantier) {
      return { success: false, message: 'Plan introuvable dans cette organisation' };
    }

    const reserves = await Reserve.findAll({
      where: { planId },
      attributes: ['id', 'numero', 'titre', 'statut', 'severite'],
      include: [
        { model: ReservePosition, as: 'position', required: false },
        { model: Media, as: 'medias', attributes: ['id', 'url', 'thumbnail_url'], separate: true, limit: 1, order: [['createdAt', 'ASC']] },
      ],
      order: [['numero', 'ASC']],
    });
    plan.dataValues.reserves = reserves;

    return { success: true, plan };
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
