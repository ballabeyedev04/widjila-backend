'use strict';

/**
 * Sous-plans : un plan peut être le DÉTAIL d'un autre plan.
 *
 * ── Le besoin ─────────────────────────────────────────────────────────────
 *
 * La hiérarchie des plans vient aujourd'hui de la STRUCTURE du chantier —
 * bâtiment, étage, zone — et s'arrête donc à l'appartement. Le client a
 * confirmé le besoin d'aller plus bas : un plan de détail d'une pièce, d'un
 * local technique ou d'une façade, ouvert depuis le plan de l'appartement,
 * avec ses propres réserves.
 *
 * ── Pourquoi une relation récursive, et pas un cinquième niveau ────────────
 *
 * Ajouter une table `pieces` obligerait à en ajouter une autre au niveau
 * suivant, puis une autre. `parent_id` pointant sur la même table donne une
 * profondeur quelconque sans jamais retoucher le schéma.
 *
 * ── Pourquoi cela ne crée PAS une seconde hiérarchie concurrente ───────────
 *
 * C'est le point délicat, et la règle est stricte :
 *
 *   - `parent_id IS NULL` — la place du plan est donnée par ses liens de
 *     structure (`batiment_id`, `etage_id`, `zone_id`). C'est le cas de TOUS
 *     les plans existants : la colonne naît nulle, rien ne change pour eux.
 *
 *   - `parent_id` renseigné — le plan est un détail de son parent, et il
 *     HÉRITE des liens de structure de celui-ci (voir plan.service.js#upload).
 *     La structure reste donc la seule source de vérité pour « dans quel
 *     bâtiment, à quel étage » ; `parent_id` ne fait qu'affiner à l'intérieur.
 *
 * Une réserve posée sur un plan de détail reste ainsi localisée dans la bonne
 * zone, le bon étage et le bon bâtiment — ce dont dépendent les rapports, les
 * filtres et le tableau de bord.
 *
 * ── ON DELETE SET NULL, et pas CASCADE ────────────────────────────────────
 *
 * Le modèle est `paranoid` : une suppression est logique, la ligne reste. Ce
 * comportement ne joue donc que sur une suppression PHYSIQUE, rare et
 * volontaire. Dans ce cas, un plan de détail qui perd son parent redevient un
 * plan ordinaire rattaché à son niveau de structure — visible, avec ses
 * réserves. CASCADE l'emporterait avec tout ce qui a été relevé dessus, sans
 * que personne l'ait demandé ; RESTRICT bloquerait la suppression du parent
 * sans dire pourquoi.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('plans');
    if (table.parent_id) return; // déjà posée

    await queryInterface.addColumn('plans', 'parent_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'plans', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    // Index : la question posée à chaque ouverture d'un plan est « quels sont
    // ses enfants directs ? ». Sans lui, elle parcourt tous les plans du
    // chantier.
    await queryInterface.addIndex('plans', ['parent_id'], {
      name: 'plans_parent_id_idx',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('plans');
    if (!table.parent_id) return;

    try {
      await queryInterface.removeIndex('plans', 'plans_parent_id_idx');
    } catch (_) {
      // L'index peut ne pas exister si `up` s'est arrêté en chemin.
    }
    await queryInterface.removeColumn('plans', 'parent_id');
  },
};
