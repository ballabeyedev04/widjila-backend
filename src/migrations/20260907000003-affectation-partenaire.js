'use strict';

/**
 * `reserve_affectations.partenaire_id` — affecter une réserve à une
 * entreprise de l'ANNUAIRE du chantier.
 *
 * ── Le bug corrigé ────────────────────────────────────────────────────────
 *
 * L'écran « Choisir qui affecter » du mobile propose deux onglets : ÉQUIPE
 * (les comptes de l'organisation) et INTERVENANT. L'onglet Intervenant liste
 * l'annuaire du chantier — la table `partenaires` — mais envoyait l'identifiant
 * choisi dans le champ `entrepriseId`, qui référence `organisations`.
 *
 * Le serveur cherchait donc une ORGANISATION portant un identifiant de
 * PARTENAIRE. Il n'en trouvait évidemment aucune et répondait « Entreprise
 * introuvable » — pour une entreprise qui existait bel et bien, à un poste
 * près dans le modèle de données.
 *
 * ── Pourquoi une colonne et pas une correspondance ────────────────────────
 *
 * On ne peut pas « traduire » un partenaire en organisation : la plupart des
 * entreprises d'un chantier n'ont AUCUN compte sur la plateforme. C'est
 * précisément la raison d'être de la table `partenaires`, et c'est déjà la
 * règle que suit la réserve elle-même (`reserves.partenaire_id` à côté de
 * `reserves.entreprise_id`, voir `reserve.model.js`). L'affectation était le
 * seul endroit du produit à ne pas l'appliquer.
 *
 * Les deux colonnes coexistent donc, avec la même division du travail :
 *   - `partenaire_id` dit QUI est responsable — toujours renseignable ;
 *   - `entreprise_id` dit à quel espace client l'affectation doit apparaître —
 *     seulement si l'entreprise est utilisatrice de la plateforme.
 *
 * ── ON DELETE CASCADE ─────────────────────────────────────────────────────
 *
 * Aligné sur `partenaires` → une fiche d'annuaire supprimée emporte les
 * affectations qui la désignaient : elles ne pointeraient plus vers personne,
 * et une affectation sans destinataire n'a aucun sens (contrairement à une
 * réserve, qui garde son constat). `Partenaire` n'est pas paranoid — la
 * suppression est physique, la cascade joue donc réellement.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('reserve_affectations');
    if (!existe) return;

    const colonnes = await queryInterface.describeTable('reserve_affectations');
    if (colonnes.partenaire_id) return; // déjà posée

    await queryInterface.addColumn('reserve_affectations', 'partenaire_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'partenaires', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });

    // Lecture dominante : « qui est affecté à cette réserve ? » joint les trois
    // destinataires possibles. Et, pour l'espace d'une entreprise partenaire :
    // « quelles réserves m'a-t-on affectées ? ».
    await queryInterface.addIndex('reserve_affectations', ['partenaire_id'], {
      name: 'reserve_affectations_partenaire_id',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('reserve_affectations');
    if (!existe) return;

    const colonnes = await queryInterface.describeTable('reserve_affectations');
    if (!colonnes.partenaire_id) return;

    try {
      await queryInterface.removeIndex('reserve_affectations', 'reserve_affectations_partenaire_id');
    } catch (_) {
      // L'index peut ne pas exister si `up` s'est arrêté en chemin.
    }
    await queryInterface.removeColumn('reserve_affectations', 'partenaire_id');
  },
};
