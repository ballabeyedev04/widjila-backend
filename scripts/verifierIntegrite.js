'use strict';

/**
 * Réconciliation — vérifie les INVARIANTS MÉTIER directement en base.
 *
 * Les services refusent désormais les écritures incohérentes ; ce script
 * rattrape ce qu'ils ne voient pas : données antérieures aux correctifs,
 * écritures faites à la main, migration non appliquée, course résiduelle.
 *
 * LECTURE SEULE (transaction READ ONLY) — aucune correction automatique :
 * chaque écart est listé avec quelques identifiants, pour une reprise à la
 * main. Chaque invariant tourne dans son propre savepoint : une requête qui
 * échoue (schéma en retard) est signalée sans masquer les autres.
 *
 *   node scripts/verifierIntegrite.js           # base du .env
 *   node scripts/verifierIntegrite.js --json    # sortie machine
 *
 * Code de sortie : 1 si un invariant CRITIQUE ou ELEVE est violé (ou n'a pas
 * pu être vérifié), 0 sinon.
 */

const { QueryTypes } = require('sequelize');
const { GESTION } = require('../src/config/roles.js');

const GESTIONNAIRES = GESTION.filter((r) => r !== 'Admin');
const STATUTS_DEMANDE = ['en_attente_validation', 'rejete'];

/** Chaque requête rend une colonne `id` par écart. */
const INVARIANTS = [
  // ── Abonnements ─────────────────────────────────────────────────────────
  {
    code: 'ABO-1', gravite: 'CRITIQUE',
    libelle: 'Plus d’une souscription active pour une même organisation',
    sql: `SELECT organisation_id AS id FROM abonnements_souscrits
          WHERE statut = 'active' GROUP BY organisation_id HAVING count(*) > 1`,
  },
  {
    code: 'ABO-2', gravite: 'CRITIQUE',
    libelle: 'Souscription au montant négatif ou à la période inversée',
    sql: `SELECT id FROM abonnements_souscrits
          WHERE prix_paye < 0 OR (date_debut IS NOT NULL AND date_fin IS NOT NULL AND date_fin < date_debut)`,
  },
  {
    code: 'ABO-3', gravite: 'ELEVE',
    libelle: 'Organisation qui a payé (souscription active en cours) mais marquée NON abonnée — client bloqué',
    sql: `SELECT o.id FROM organisations o
          WHERE o.deleted_at IS NULL AND o.is_subscribed IS NOT TRUE
            AND EXISTS (SELECT 1 FROM abonnements_souscrits a
                        WHERE a.organisation_id = o.id AND a.statut = 'active'
                          AND (a.date_fin IS NULL OR a.date_fin > now()))`,
  },
  {
    code: 'ABO-4', gravite: 'MOYEN',
    libelle: 'Organisation racine marquée abonnée sans aucune souscription active — accès gratuit',
    sql: `SELECT o.id FROM organisations o
          WHERE o.deleted_at IS NULL AND o.parent_id IS NULL AND o.is_subscribed IS TRUE
            AND NOT EXISTS (SELECT 1 FROM abonnements_souscrits a
                            WHERE a.organisation_id = o.id AND a.statut = 'active')`,
  },
  {
    code: 'ABO-5', gravite: 'MOYEN',
    libelle: 'Souscription encore « active » après sa date de fin',
    sql: `SELECT id FROM abonnements_souscrits WHERE statut = 'active' AND date_fin < now()`,
  },
  {
    code: 'ABO-6', gravite: 'MOYEN',
    libelle: 'Organisation au-delà du plafond d’utilisateurs actifs de sa formule',
    sql: `SELECT a.organisation_id AS id FROM abonnements_souscrits a
          JOIN plans_abonnement p ON p.id = a.plan_abonnement_id
          WHERE a.statut = 'active' AND p.limite_utilisateurs IS NOT NULL
            AND (SELECT count(*) FROM utilisateur u
                 WHERE u.organisation_id = a.organisation_id AND u.deleted_at IS NULL AND u.statut = 'actif')
                > p.limite_utilisateurs`,
  },

  // ── Chantiers ───────────────────────────────────────────────────────────
  {
    code: 'CH-1', gravite: 'ELEVE',
    libelle: 'Plans ouverts sur une demande non validée, ou plans en attente sur un chantier validé',
    sql: `SELECT p.id FROM plans p JOIN chantiers c ON c.id = p.chantier_id
          WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL
            AND ((c.statut IN (:demande) AND p.statut = 'actif')
              OR (c.statut NOT IN (:demande) AND p.statut = 'en_attente_validation'))`,
  },
  {
    code: 'CH-2', gravite: 'FAIBLE',
    libelle: 'Demandeur d’un chantier validé absent de son équipe (rattachement toléré en échec)',
    sql: `SELECT c.id FROM chantiers c
          WHERE c.deleted_at IS NULL AND c.demandeur_id IS NOT NULL AND c.statut NOT IN (:demande)
            AND c.valide_le IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM chantier_membres m
                            WHERE m.chantier_id = c.id AND m.utilisateur_id = c.demandeur_id)`,
  },

  // ── Plans ───────────────────────────────────────────────────────────────
  {
    code: 'PLAN-1', gravite: 'ELEVE',
    libelle: 'Plusieurs versions COURANTES dans une même lignée de plan',
    sql: `SELECT min(id::text) AS id FROM plans
          WHERE deleted_at IS NULL AND is_current IS TRUE
          GROUP BY chantier_id, nom, parent_id, batiment_id, etage_id, zone_id HAVING count(*) > 1`,
  },
  {
    code: 'PLAN-2', gravite: 'MOYEN',
    libelle: 'Lignée de plan sans aucune version courante',
    sql: `SELECT min(id::text) AS id FROM plans WHERE deleted_at IS NULL
          GROUP BY chantier_id, nom, parent_id, batiment_id, etage_id, zone_id
          HAVING NOT bool_or(coalesce(is_current, false))`,
  },
  {
    code: 'PLAN-3', gravite: 'MOYEN',
    libelle: 'Sous-plan rattaché à un parent supprimé ou à une version non courante',
    sql: `SELECT p.id FROM plans p JOIN plans parent ON parent.id = p.parent_id
          WHERE p.deleted_at IS NULL AND (parent.deleted_at IS NOT NULL OR parent.is_current IS NOT TRUE)`,
  },
  {
    code: 'PLAN-4', gravite: 'ELEVE',
    libelle: 'Sous-plan dont le parent appartient à un AUTRE chantier',
    sql: `SELECT p.id FROM plans p JOIN plans parent ON parent.id = p.parent_id
          WHERE p.deleted_at IS NULL AND parent.chantier_id <> p.chantier_id`,
  },

  // ── Réserves ────────────────────────────────────────────────────────────
  {
    code: 'RES-1', gravite: 'ELEVE',
    libelle: 'Réserve ouverte sur un chantier clôturé ou archivé',
    sql: `SELECT r.id FROM reserves r JOIN chantiers c ON c.id = r.chantier_id
          WHERE r.deleted_at IS NULL AND c.statut IN ('cloture', 'archive')
            AND r.statut NOT IN ('validee', 'cloturee')`,
  },
  {
    code: 'RES-2', gravite: 'CRITIQUE',
    libelle: 'Numéro de réserve en double sur un chantier',
    sql: `SELECT min(id::text) AS id FROM reserves GROUP BY chantier_id, numero HAVING count(*) > 1`,
  },
  {
    code: 'RES-3', gravite: 'ELEVE',
    libelle: 'Réserve posée sur le plan d’un AUTRE chantier',
    sql: `SELECT r.id FROM reserves r JOIN plans p ON p.id = r.plan_id
          WHERE r.deleted_at IS NULL AND p.chantier_id <> r.chantier_id`,
  },
  {
    code: 'RES-4', gravite: 'ELEVE',
    libelle: 'Réserve rattachée au bâtiment d’un AUTRE chantier',
    sql: `SELECT r.id FROM reserves r JOIN batiments b ON b.id = r.batiment_id
          WHERE r.deleted_at IS NULL AND b.chantier_id <> r.chantier_id`,
  },
  {
    code: 'RES-5', gravite: 'MOYEN',
    libelle: 'Réserve posée sur un plan supprimé',
    sql: `SELECT r.id FROM reserves r JOIN plans p ON p.id = r.plan_id
          WHERE r.deleted_at IS NULL AND p.deleted_at IS NOT NULL`,
  },
  {
    code: 'RES-6', gravite: 'MOYEN',
    libelle: 'Réserve « en retard » dont l’échéance n’est pas dépassée',
    sql: `SELECT id FROM reserves
          WHERE deleted_at IS NULL AND statut = 'en_retard'
            AND (date_limite IS NULL OR date_limite >= current_date)`,
  },
  {
    code: 'RES-7', gravite: 'MOYEN',
    libelle: 'Réserve validée ou clôturée sans aucune preuve (média)',
    sql: `SELECT r.id FROM reserves r
          WHERE r.deleted_at IS NULL AND r.statut IN ('validee', 'cloturee')
            AND NOT EXISTS (SELECT 1 FROM medias m WHERE m.reserve_id = r.id)`,
  },

  {
    code: 'RES-8', gravite: 'MOYEN',
    libelle: 'Réserve validée sans date de validation (verdict non tracé)',
    sql: `SELECT id FROM reserves WHERE deleted_at IS NULL AND statut = 'validee' AND date_validation IS NULL`,
  },

  // ── Rapports ────────────────────────────────────────────────────────────
  {
    code: 'RAP-1', gravite: 'ELEVE',
    libelle: 'Rapport « généré » ou « envoyé » sans fichier',
    sql: `SELECT id FROM rapports
          WHERE deleted_at IS NULL AND statut IN ('genere', 'envoye') AND fichier_url IS NULL`,
  },
  {
    code: 'RAP-2', gravite: 'MOYEN',
    libelle: 'Génération de rapport bloquée depuis plus de 15 minutes',
    sql: `SELECT id FROM rapports
          WHERE deleted_at IS NULL AND statut = 'generation' AND updated_at < now() - interval '15 minutes'`,
  },
  {
    code: 'RAP-3', gravite: 'ELEVE',
    libelle: 'Nouvelle version de rapport dont la version précédente n’est pas archivée',
    sql: `SELECT r.id FROM rapports r JOIN rapports parent ON parent.id = r.rapport_parent_id
          WHERE r.deleted_at IS NULL AND parent.deleted_at IS NULL AND parent.statut <> 'archive'`,
  },

  // ── Comptes ─────────────────────────────────────────────────────────────
  {
    code: 'USR-1', gravite: 'CRITIQUE',
    libelle: 'Compte supprimé disposant encore d’une session valide',
    sql: `SELECT DISTINCT u.id FROM utilisateur u JOIN refresh_tokens t ON t.utilisateur_id = u.id
          WHERE u.deleted_at IS NOT NULL AND t.revoked = false AND t.expires_at > now()`,
  },
  {
    code: 'USR-2', gravite: 'ELEVE',
    libelle: 'Compte supprimé NON pseudonymisé (données personnelles conservées)',
    sql: `SELECT id FROM utilisateur
          WHERE deleted_at IS NOT NULL AND NOT (email LIKE 'deleted%' AND email LIKE '%@deleted.local')`,
  },
  {
    code: 'USR-3', gravite: 'ELEVE',
    libelle: 'Organisation avec des membres actifs mais AUCUN gestionnaire actif',
    sql: `SELECT o.id FROM organisations o
          WHERE o.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM utilisateur u
                        WHERE u.organisation_id = o.id AND u.deleted_at IS NULL AND u.statut = 'actif')
            AND NOT EXISTS (SELECT 1 FROM utilisateur u
                            WHERE u.organisation_id = o.id AND u.deleted_at IS NULL AND u.statut = 'actif'
                              AND u.role IN (:gestionnaires))`,
  },

  // ── Base ────────────────────────────────────────────────────────────────
  // Une création d'index `CONCURRENTLY` interrompue laisse un index INVALIDE :
  // le planificateur l'ignore, et la migration qui l'a posé est pourtant
  // inscrite comme jouée — elle ne sera jamais rejouée (voir
  // migrations/20260912000001-perf-index-chemin-chaud.js). Non bloquant : les
  // données sont intactes, seules les performances en pâtissent. Remède :
  // `DROP INDEX CONCURRENTLY <nom>` puis recréer l'index.
  {
    code: 'IDX-1', gravite: 'MOYEN',
    libelle: 'Index invalide (création interrompue) — ignoré par la base, à recréer',
    sql: `SELECT c.relname AS id FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE NOT i.indisvalid`,
  },
];

const BLOQUANTES = ['CRITIQUE', 'ELEVE'];

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ echantillon?: number }} [options] nombre d'identifiants cités par écart
 * @returns {Promise<Array<{code, gravite, libelle, nombre, exemples, erreur?}>>}
 */
async function verifierInvariants(sequelize, { echantillon = 5 } = {}) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
    const resultats = [];
    for (const inv of INVARIANTS) {
      const base = { code: inv.code, gravite: inv.gravite, libelle: inv.libelle };
      try {
        const lignes = await sequelize.transaction({ transaction }, (sp) => sequelize.query(
          `SELECT ecart.id::text AS id FROM (${inv.sql}) AS ecart`,
          { type: QueryTypes.SELECT, transaction: sp, replacements: { demande: STATUTS_DEMANDE, gestionnaires: GESTIONNAIRES } }
        ));
        resultats.push({ ...base, nombre: lignes.length, exemples: lignes.slice(0, echantillon).map((l) => l.id) });
      } catch (err) {
        resultats.push({ ...base, nombre: null, exemples: [], erreur: err.message });
      }
    }
    return resultats;
  });
}

/** Vrai si un écart bloquant existe, ou si un invariant bloquant n'a pu être vérifié. */
function estBloquant(resultats) {
  return resultats.some((r) => BLOQUANTES.includes(r.gravite) && (r.erreur || r.nombre > 0));
}

function afficher(resultats) {
  for (const r of resultats) {
    const etat = r.erreur ? 'NON VÉRIFIÉ' : (r.nombre === 0 ? 'OK' : `${r.nombre} écart(s)`);
    console.log(`[${r.gravite.padEnd(8)}] ${r.code.padEnd(7)} ${etat.padEnd(14)} ${r.libelle}`);
    if (r.erreur) console.log(`           ↳ ${r.erreur}`);
    else if (r.nombre) console.log(`           ↳ ex. ${r.exemples.join(', ')}`);
  }
}

if (require.main === module) {
  const sequelize = require('../src/config/db.js');
  verifierInvariants(sequelize)
    .then((resultats) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(resultats, null, 2));
      else afficher(resultats);
      process.exitCode = estBloquant(resultats) ? 1 : 0;
    })
    .catch((err) => {
      console.error(`Vérification impossible : ${err.message}`);
      process.exitCode = 2;
    })
    .finally(() => sequelize.close());
}

module.exports = { verifierInvariants, estBloquant, INVARIANTS };
