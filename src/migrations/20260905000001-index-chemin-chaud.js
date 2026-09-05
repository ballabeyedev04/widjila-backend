'use strict';

/**
 * Index des requêtes les plus fréquentes de l'application.
 *
 * ── Pourquoi ils manquent ─────────────────────────────────────────────────
 *
 * Les modèles Sequelize déclarent bien ces index dans leur bloc `indexes:`.
 * Mais ce bloc n'est appliqué que par `sequelize.sync()`, et `sync()` a été
 * retiré du démarrage en production (voir `server.js`) : le schéma y vient
 * des migrations, et d'elles seules.
 *
 * Résultat : 56 index déclarés dans les modèles n'existent pas en base. Rien
 * ne le signale — les requêtes répondent, simplement en parcourant la table
 * entière. C'est la même mécanique qui avait fait disparaître la table
 * `chantier_membres`, avec un symptôme plus discret : une lenteur qui croît
 * avec les données, au lieu d'une erreur franche.
 *
 * ── Ce que cette migration pose, et ce qu'elle laisse ─────────────────────
 *
 * Pas les 56. Un index n'est pas gratuit : il ralentit chaque écriture et
 * occupe de la place. Ne sont posés ici que ceux dont une requête PRÉCISE,
 * nommée en commentaire, justifie l'existence — celles du chemin chaud, que
 * l'application déclenche à chaque écran.
 *
 * Les autres restent à poser au cas par cas, quand une mesure les justifiera.
 *
 * ── Idempotence ───────────────────────────────────────────────────────────
 *
 * `IF NOT EXISTS` : sur une base créée par l'ancien `sync()`, une partie de
 * ces index existe peut-être déjà sous un autre nom. La migration doit
 * pouvoir passer dans les deux cas sans échouer.
 */

/** Chaque entrée porte la requête qui la justifie. */
const INDEX = [
  // ── Le filtre le plus chaud de toute l'application ──────────────────────
  // `DashboardService._whereOrganisation` et `ChantierService.listChantiers`
  // filtrent TOUS les deux sur (organisation_id, statut). C'est l'écran
  // d'accueil et la liste des chantiers, donc la première requête de chaque
  // session, et elle parcourait la table entière.
  {
    nom: 'idx_chantiers_organisation_statut',
    sql: 'CREATE INDEX IF NOT EXISTS idx_chantiers_organisation_statut '
      + 'ON chantiers (organisation_id, statut)',
  },

  // La pastille de la cloche : `NotificationService.compterNonLues` fait
  // `count({ utilisateurId, lu_a: null })`. Elle est appelée depuis l'en-tête
  // de CHAQUE écran de liste — c'est la requête la plus répétée du produit.
  {
    nom: 'idx_notifications_utilisateur_lu',
    sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_utilisateur_lu '
      + 'ON notifications (utilisateur_id, lu_a)',
  },

  // Le tableau de bord compte les réserves par statut, chantier par chantier.
  // L'index existant est (chantier_id, numero) : sa colonne de tête sert le
  // filtre par chantier, mais le regroupement par statut retombe sur un tri.
  {
    nom: 'idx_reserves_chantier_statut',
    sql: 'CREATE INDEX IF NOT EXISTS idx_reserves_chantier_statut '
      + 'ON reserves (chantier_id, statut)',
  },

  // ── Traversée de la structure d'un chantier ─────────────────────────────
  // Bâtiments → étages → zones, parcourus en cascade par l'assistant de
  // création de réserve et par la navigation dans les plans. Trois niveaux,
  // donc trois parcours complets de table à chaque ouverture.
  {
    nom: 'idx_batiments_chantier',
    sql: 'CREATE INDEX IF NOT EXISTS idx_batiments_chantier ON batiments (chantier_id)',
  },
  {
    nom: 'idx_etages_batiment',
    sql: 'CREATE INDEX IF NOT EXISTS idx_etages_batiment ON etages (batiment_id)',
  },
  {
    nom: 'idx_zones_etage',
    sql: 'CREATE INDEX IF NOT EXISTS idx_zones_etage ON zones (etage_id)',
  },

  // ── Fiche d'une réserve ─────────────────────────────────────────────────
  // Son ouverture déclenche trois listes séparées — photos, commentaires,
  // historique — toutes filtrées sur la même réserve.
  {
    nom: 'idx_medias_reserve',
    sql: 'CREATE INDEX IF NOT EXISTS idx_medias_reserve ON medias (reserve_id)',
  },
  {
    nom: 'idx_commentaires_reserve',
    sql: 'CREATE INDEX IF NOT EXISTS idx_commentaires_reserve ON commentaires (reserve_id)',
  },
  {
    nom: 'idx_reserve_historiques_reserve',
    sql: 'CREATE INDEX IF NOT EXISTS idx_reserve_historiques_reserve '
      + 'ON reserve_historiques (reserve_id)',
  },
  {
    nom: 'idx_reserve_affectations_reserve',
    sql: 'CREATE INDEX IF NOT EXISTS idx_reserve_affectations_reserve '
      + 'ON reserve_affectations (reserve_id)',
  },

  // ── Listes par chantier ─────────────────────────────────────────────────
  // Inspections et rapports ont chacun leur onglet, filtré sur le chantier.
  // Les documents et les plans, eux, sont déjà servis par la colonne de tête
  // de leurs index composites existants — rien à ajouter pour eux.
  {
    nom: 'idx_inspections_chantier',
    sql: 'CREATE INDEX IF NOT EXISTS idx_inspections_chantier ON inspections (chantier_id)',
  },
  {
    nom: 'idx_rapports_chantier',
    sql: 'CREATE INDEX IF NOT EXISTS idx_rapports_chantier ON rapports (chantier_id)',
  },

  // ── Historique de connexion ─────────────────────────────────────────────
  // Lu par l'écran Réglages, trié par date décroissante et limité à 50 : sans
  // index, c'est un tri sur la table entière des connexions, qui ne fait que
  // grossir.
  {
    nom: 'idx_connexion_logs_utilisateur_date',
    sql: 'CREATE INDEX IF NOT EXISTS idx_connexion_logs_utilisateur_date '
      + 'ON connexion_logs (utilisateur_id, created_at DESC)',
  },
];

module.exports = {
  async up(queryInterface) {
    // Les tables sont listées à l'exécution : sur une base incomplète, mieux
    // vaut poser ce qui peut l'être que de tout faire échouer sur une table
    // absente.
    const tables = new Set(await queryInterface.showAllTables());

    for (const { nom, sql } of INDEX) {
      const table = / ON ([a-z_]+) /.exec(sql)[1];
      if (!tables.has(table)) continue;
      try {
        await queryInterface.sequelize.query(sql);
      } catch (err) {
        // Un index équivalent existe peut-être déjà sous un autre nom, posé
        // par l'ancien `sync()`. Ce n'est pas une raison d'interrompre la
        // migration : les suivants restent utiles.
        // eslint-disable-next-line no-console
        console.warn(`[index] ${nom} non posé : ${err.message}`);
      }
    }
  },

  async down(queryInterface) {
    for (const { nom } of INDEX) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${nom}`);
    }
  },
};
