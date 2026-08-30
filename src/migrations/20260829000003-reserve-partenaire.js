'use strict';

/**
 * Migration : `reserves.partenaire_id` — le champ « Entreprise concernée » du
 * guide client.
 *
 * POURQUOI UNE NOUVELLE COLONNE plutôt que réutiliser `entreprise_id` :
 * `entreprise_id` référence une ORGANISATION, c'est-à-dire une entreprise qui
 * possède un compte dans l'application. Or l'écran de création de réserve
 * proposait déjà la liste des PARTENAIRES — de simples fiches d'annuaire, sans
 * compte — et y écrivait leur identifiant. La valeur enregistrée ne désignait
 * donc aucune organisation existante : la jointure `entreprise` renvoyait
 * `null`, et la réserve s'affichait sans entreprise responsable alors qu'une
 * entreprise avait bien été choisie.
 *
 * Les deux colonnes coexistent et ne disent pas la même chose :
 *   - `partenaire_id` : QUI est responsable (toujours renseignable) ;
 *   - `entreprise_id` : dans quel espace client la réserve doit apparaître
 *     (seulement si cette entreprise utilise elle-même la plateforme).
 *
 * Additive et rétrocompatible : colonne NULLABLE, aucune donnée existante
 * touchée. Les valeurs déjà (mal) posées dans `entreprise_id` ne sont pas
 * migrées automatiquement — on ne peut pas distinguer après coup un id
 * d'organisation légitime d'un id de partenaire, et deviner reviendrait à
 * réécrire des données métier au jugé.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('reserves');
    if (table.partenaire_id) return;

    await queryInterface.addColumn('reserves', 'partenaire_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'partenaires', key: 'id' },
      onUpdate: 'CASCADE',
      // SET NULL : retirer une entreprise de l'annuaire ne doit pas emporter
      // les réserves qu'elle devait lever — elles restent, sans responsable
      // désigné, ce qui est précisément l'information utile.
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex('reserves', ['partenaire_id'], {
      name: 'reserves_partenaire_id',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('reserves');
    if (table.partenaire_id) await queryInterface.removeColumn('reserves', 'partenaire_id');
  },
};
