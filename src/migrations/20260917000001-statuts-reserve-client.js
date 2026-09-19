'use strict';

/**
 * Migration : quatre statuts de réserve demandés par le client après la
 * recette — `a_surveiller`, `a_echeance`, `traitee`, `levee`.
 *
 * Aligne le type ENUM PostgreSQL sur `config/enums.js#STATUT_RESERVE` et sur
 * `reserve.model.js`. `AFTER` place chaque valeur à son rang dans le cycle de
 * vie : un tri SQL sur `statut` suit l'ordre de l'ENUM, et une valeur ajoutée
 * en fin de type classerait « à surveiller » après « clôturée ».
 *
 * `IF NOT EXISTS` : rejouable sans erreur (base déjà migrée à la main,
 * reprise après un déploiement interrompu).
 *
 * `ALTER TYPE … ADD VALUE` ne peut pas s'exécuter dans un bloc de transaction
 * sur PostgreSQL < 12 ; chaque valeur part donc dans sa propre requête, hors
 * transaction explicite.
 */
const AJOUTS = [
  ['a_surveiller', 'en_cours'],
  ['a_echeance', 'a_surveiller'],
  ['traitee', 'corrigee'],
  ['levee', 'validee'],
];

module.exports = {
  async up(queryInterface) {
    for (const [valeur, apres] of AJOUTS) {
      await queryInterface.sequelize.query(
        `ALTER TYPE "enum_reserves_statut" ADD VALUE IF NOT EXISTS '${valeur}' AFTER '${apres}';`
      );
    }
  },

  async down() {
    // PostgreSQL ne sait pas retirer une valeur d'un ENUM sans recréer le type
    // — et des réserves portent peut-être déjà ces statuts.
    console.warn('Rollback non supporté pour ALTER TYPE ENUM (PostgreSQL).');
  },
};
