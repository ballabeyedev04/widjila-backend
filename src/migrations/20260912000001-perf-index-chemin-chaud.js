'use strict';

/**
 * Index du chemin chaud — second lot (audit performance).
 *
 * Même règle que 20260905000001-index-chemin-chaud.js : un index n'est posé
 * que si une requête PRÉCISE, nommée en commentaire, le justifie. Chaque index
 * ralentit les écritures de sa table ; `reserves` en porte déjà une dizaine,
 * elle n'en reçoit ici que trois de plus.
 *
 * ── CONCURRENTLY ──────────────────────────────────────────────────────────
 * Un CREATE INDEX classique verrouille les ÉCRITURES de la table pendant toute
 * sa construction : sur `reserves` en production, l'application ne pourrait
 * plus créer ni modifier de réserve le temps de la migration. CONCURRENTLY
 * construit l'index sans bloquer les écritures. Il ne peut pas tourner dans
 * une transaction — sequelize-cli n'en ouvre pas autour d'une migration.
 *
 * Un index CONCURRENTLY interrompu reste en base, marqué INVALID, et
 * `IF NOT EXISTS` le laisserait tel quel : on le supprime donc avant de le
 * reconstruire (voir `poser`).
 *
 * NOT VERIFIED : les plans d'exécution (EXPLAIN) n'ont pas pu être mesurés sur
 * une base de volume réel au moment de l'audit ; chaque index vise une
 * colonne de filtre ou de tri d'une requête du chemin chaud, sans index
 * existant qui la serve.
 */

const INDEX = [
  // ── Réserves d'un plan ──────────────────────────────────────────────────
  // `PlanService` (écran plan du mobile, compteurs de réserves par plan,
  // explorateur de plans du web) filtre `reserves.plan_id`. Aucun index : un
  // parcours complet de la table la plus volumineuse à chaque ouverture de plan.
  {
    nom: 'idx_reserves_plan',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reserves_plan ON reserves (plan_id) WHERE deleted_at IS NULL',
  },

  // ── Liste des réserves d'un chantier, la plus consultée ─────────────────
  // `ReserveService.listReserves` : WHERE chantier_id = ? ORDER BY created_at
  // DESC LIMIT 20. L'index (chantier_id, statut) sert le filtre mais laisse
  // un TRI de toutes les réserves du chantier à chaque page ; celui-ci rend
  // les 20 premières lignes directement dans l'ordre.
  {
    nom: 'idx_reserves_chantier_created',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reserves_chantier_created '
      + 'ON reserves (chantier_id, created_at DESC) WHERE deleted_at IS NULL',
  },

  // ── Jobs quotidiens d'échéance ──────────────────────────────────────────
  // `markReservesEnRetard` (22 h) et `reminders` (7 h) cherchent, TOUTES
  // organisations confondues, les réserves ouvertes dont l'échéance tombe. Un
  // index partiel ne couvre que les réserves encore ouvertes : petit, et
  // insensible à l'historique qui s'accumule.
  {
    nom: 'idx_reserves_echeance_ouvertes',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reserves_echeance_ouvertes '
      + "ON reserves (date_limite) WHERE deleted_at IS NULL AND statut NOT IN ('validee', 'cloturee')",
  },

  // ── Liste des notifications ─────────────────────────────────────────────
  // `NotificationService.listNotifications` : WHERE utilisateur_id = ? ORDER
  // BY created_at DESC. L'index (utilisateur_id, lu_a) sert la pastille, pas
  // ce tri.
  {
    nom: 'idx_notifications_utilisateur_created',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_utilisateur_created '
      + 'ON notifications (utilisateur_id, created_at DESC)',
  },

  // ── Envoi d'un push ─────────────────────────────────────────────────────
  // CHAQUE notification cherche les appareils de son destinataire :
  // `device_tokens WHERE utilisateur_id = ?`. Seul le jeton était indexé.
  {
    nom: 'idx_device_tokens_utilisateur',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_tokens_utilisateur ON device_tokens (utilisateur_id)',
  },

  // ── Photos d'une inspection ─────────────────────────────────────────────
  // `GET /inspections/:id/photos` et le détail d'une inspection filtrent
  // `medias.inspection_id` ; seul `reserve_id` était indexé.
  {
    nom: 'idx_medias_inspection',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_medias_inspection ON medias (inspection_id) WHERE inspection_id IS NOT NULL',
  },
];

async function poser(queryInterface, { nom, sql }) {
  const [[invalide]] = await queryInterface.sequelize.query(
    `SELECT 1 AS present FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = :nom AND NOT i.indisvalid`,
    { replacements: { nom } }
  );
  if (invalide) await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
  await queryInterface.sequelize.query(sql);
}

module.exports = {
  INDEX, // exporté pour les tests (src/__tests__/)

  async up(queryInterface) {
    const tables = new Set(await queryInterface.showAllTables());
    for (const index of INDEX) {
      const table = / ON ([a-z_]+) /.exec(index.sql)[1];
      if (!tables.has(table)) continue;
      try {
        await poser(queryInterface, index);
      } catch (err) {
        // Même parti pris que le premier lot : un index qui ne peut pas être
        // posé n'empêche pas les suivants, qui restent utiles.
        // eslint-disable-next-line no-console
        console.warn(`[index] ${index.nom} non posé : ${err.message}`);
      }
    }
  },

  async down(queryInterface) {
    for (const { nom } of INDEX) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
    }
  },
};
