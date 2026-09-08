'use strict';

/**
 * Cahier technique Widjila (v1.0, septembre 2026) — les champs qui manquaient.
 *
 * Quatre ajouts, chacun demandé explicitement par le document du client :
 *
 * ── 1. `plans.type_plan` — § 4 « Import d'un plan » ───────────────────────
 *
 * Le formulaire d'import doit porter un champ « Type : Architecture,
 * électricité, plomberie, etc. ». Rien ne le stockait : deux plans d'un même
 * niveau, l'un architectural et l'autre électrique, étaient indiscernables
 * autrement que par leur nom — et c'est précisément la superposition de ces
 * disciplines qui fait le suivi d'un chantier.
 *
 * Texte libre borné, et non un ENUM : le document dit « etc. ». Un ENUM
 * imposerait une migration à chaque discipline nouvelle (désenfumage, courants
 * faibles, VRD…), pour une donnée qui n'entre dans aucune règle métier.
 *
 * ── 2. `plans.date_plan` — § 4 ───────────────────────────────────────────
 *
 * « Date : date du plan ». Distincte de `created_at`, qui est la date de
 * DÉPÔT. Un plan daté du 3 mars peut être versé en septembre ; confondre les
 * deux fait croire que le chantier travaille sur un document récent.
 *
 * ── 3. `plans.is_current` — § 10 et § 15 ─────────────────────────────────
 *
 * « La version courante est identifiée par is_current = true ».
 *
 * Le code la DÉDUISAIT jusqu'ici, en prenant le plus grand numéro de version.
 * Deux défauts : la déduction se refait à chaque requête, et surtout elle
 * interdit de désigner comme courante autre chose que la dernière — alors que
 * le § 15 demande justement de pouvoir « afficher clairement la version
 * active » sans rien déplacer automatiquement.
 *
 * REMPLISSAGE : la version la plus haute de chaque (chantier, nom) devient
 * courante, ce qui reproduit exactement le comportement actuel. Aucun écran ne
 * change de contenu le jour de la migration.
 *
 * ── 4. `reserve_positions.page` — § 6 et § 18 ────────────────────────────
 *
 * « Changement de page si le PDF en contient plusieurs », et le test
 * indispensable « Plan multi-page → bonne page associée à la réserve ».
 *
 * La position ne portait que x et y. Sur un PDF de douze pages, les douze
 * réserves se dessinaient donc TOUTES sur la page affichée, quelle qu'elle
 * soit — chacune au bon endroit, mais sur la mauvaise page. Défaut `1` : un
 * PDF d'une seule page est le cas courant, et toutes les réserves déjà posées
 * l'ont été sur la première.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const plans = await queryInterface.describeTable('plans');

    if (!plans.type_plan) {
      await queryInterface.addColumn('plans', 'type_plan', {
        type: Sequelize.STRING(80),
        allowNull: true,
      });
      // Lecture attendue : « les plans d'électricité de ce chantier ».
      await queryInterface.addIndex('plans', ['chantier_id', 'type_plan'], {
        name: 'plans_chantier_type_idx',
      });
    }

    if (!plans.date_plan) {
      await queryInterface.addColumn('plans', 'date_plan', {
        type: Sequelize.DATEONLY,
        allowNull: true,
      });
    }

    if (!plans.is_current) {
      await queryInterface.addColumn('plans', 'is_current', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        // `true` par défaut : un plan déposé est courant tant qu'aucun autre ne
        // le remplace. C'est le service de dépôt qui bascule le précédent à
        // `false`, dans la même transaction.
        defaultValue: true,
      });

      // Remplissage — la version la plus haute de chaque (chantier, nom).
      //
      // `deleted_at IS NULL` : une version supprimée logiquement ne peut pas
      // être la version courante, et ne doit pas empêcher la précédente de
      // l'être.
      await queryInterface.sequelize.query(`
        UPDATE plans p
           SET is_current = (
                 p.version = (
                   SELECT MAX(p2.version)
                     FROM plans p2
                    WHERE p2.chantier_id = p.chantier_id
                      AND p2.nom = p.nom
                      AND p2.deleted_at IS NULL
                 )
               )
         WHERE p.deleted_at IS NULL;
      `);

      // Index PARTIEL : la question « quelle est la version courante ? » est
      // posée à chaque liste de plans. Filtré sur `true`, il ne porte qu'une
      // ligne par plan au lieu de toutes les versions.
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS plans_chantier_courant_idx
            ON plans (chantier_id)
         WHERE is_current = true AND deleted_at IS NULL;
      `);
    }

    const positions = await queryInterface.describeTable('reserve_positions');
    if (!positions.page) {
      await queryInterface.addColumn('reserve_positions', 'page', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      });
    }
  },

  async down(queryInterface) {
    const positions = await queryInterface.describeTable('reserve_positions');
    if (positions.page) await queryInterface.removeColumn('reserve_positions', 'page');

    const plans = await queryInterface.describeTable('plans');

    if (plans.is_current) {
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS plans_chantier_courant_idx;');
      await queryInterface.removeColumn('plans', 'is_current');
    }
    if (plans.date_plan) await queryInterface.removeColumn('plans', 'date_plan');
    if (plans.type_plan) {
      try {
        await queryInterface.removeIndex('plans', 'plans_chantier_type_idx');
      } catch (_) {
        // L'index peut ne pas exister si `up` s'est arrêté en chemin.
      }
      await queryInterface.removeColumn('plans', 'type_plan');
    }
  },
};
