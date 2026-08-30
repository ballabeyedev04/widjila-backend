'use strict';

/**
 * Migration : `reserves.phase_id`.
 *
 * Règle métier demandée : chaque réserve est associée à une phase du chantier,
 * et cette association ne bouge JAMAIS ensuite — une réserve constatée en
 * « Pré-cloisons » reste en Pré-cloisons quand le chantier passe en
 * « Cloisons ». C'est ce qui rend l'historique par phase exploitable.
 *
 * ── Pourquoi la colonne est NULLABLE alors que la phase est obligatoire ───
 * L'obligation porte sur les réserves À VENIR, et elle est appliquée par la
 * VALIDATION de l'API (`creerReserveSchema`), donc y compris pour une requête
 * directe qui contournerait l'interface.
 *
 * La poser NOT NULL en base exigerait d'inventer une phase pour toutes les
 * réserves DÉJÀ enregistrées, qui ont été constatées avant que la notion
 * existe. Leur en attribuer une au hasard fabriquerait un historique faux —
 * exactement ce que le client demande d'éviter. Elles restent donc à NULL,
 * ce qui se lit comme « phase inconnue » et non comme une phase erronée.
 *
 * ── ON DELETE RESTRICT ────────────────────────────────────────────────────
 * Dernier rempart contre la perte d'historique : même une suppression SQL
 * directe ne peut pas effacer une phase encore référencée. En fonctionnement
 * normal la contrainte ne se déclenche jamais — le service refuse déjà la
 * suppression d'une phase utilisée (il faut la désactiver), et toutes les
 * suppressions de l'application sont douces (`paranoid`), ce qui ne déclenche
 * aucune clé étrangère.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('reserves');
    if (table.phase_id) return;

    await queryInterface.addColumn('reserves', 'phase_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'phases', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });

    // Lecture dominante : « toutes les réserves de cette phase », et
    // « réserves de cette entreprise, filtrées par phase » (écran
    // d'historique). L'index composite couvre les deux.
    await queryInterface.addIndex('reserves', ['phase_id'], { name: 'reserves_phase_id' });
    await queryInterface.addIndex('reserves', ['corps_etat_id', 'phase_id'], {
      name: 'reserves_corps_etat_phase',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('reserves');
    if (table.phase_id) await queryInterface.removeColumn('reserves', 'phase_id');
  },
};
