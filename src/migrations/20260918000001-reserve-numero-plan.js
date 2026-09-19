'use strict';

/**
 * Migration : numéro de réserve PROPRE À CHAQUE PLAN — `reserves.numero_plan`.
 *
 * Sur un plan, l'utilisateur voit plusieurs repères rouges et ne sait ni
 * laquelle des réserves a été relevée en premier, ni laquelle est « la 3 ».
 * Le numéro de chantier (`R-0012`) ne l'aide pas : il court sur tout le
 * chantier, et un plan reçoit donc des numéros quelconques (R-0007, R-0031,
 * R-0044…). D'où un second numéro, entier, qui repart à 1 sur CHAQUE plan.
 *
 * ── Colonne ──────────────────────────────────────────────────────────────
 *
 * `numero_plan INTEGER NULL` : nul pour une réserve sans plan. Attribué par
 * le service à la création (voir `reserve.service.js` § NUMÉROTATION PAR
 * PLAN), jamais saisi par le client.
 *
 * ── Unicité ──────────────────────────────────────────────────────────────
 *
 * Index unique PARTIEL sur (plan_id, numero_plan) : deux réserves d'un même
 * plan ne portent jamais le même numéro, et les réserves sans plan (les deux
 * colonnes nulles) n'entrent pas dans l'index. Il couvre aussi les lignes
 * supprimées logiquement (`deleted_at`) : un numéro n'est donc JAMAIS
 * réattribué, ce qui garde une identification stable — la « réserve n°2 »
 * supprimée ne renaît pas sous les traits d'une autre.
 *
 * ── Reprise de l'existant ────────────────────────────────────────────────
 *
 * Les réserves déjà posées sur un plan sont numérotées dans leur ordre de
 * création (`created_at`, puis `id` pour départager), plan par plan, lignes
 * supprimées comprises — c'est l'ordre que les utilisateurs ont vécu, et
 * l'index exige qu'elles y figurent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reserves', 'numero_plan', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE reserves r
         SET numero_plan = s.rang
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY plan_id ORDER BY created_at, id) AS rang
            FROM reserves
           WHERE plan_id IS NOT NULL
        ) s
       WHERE r.id = s.id
         AND r.numero_plan IS NULL
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS reserves_plan_numero_plan_unique
        ON reserves (plan_id, numero_plan)
        WHERE plan_id IS NOT NULL AND numero_plan IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS reserves_plan_numero_plan_unique');
    await queryInterface.removeColumn('reserves', 'numero_plan');
  },
};
