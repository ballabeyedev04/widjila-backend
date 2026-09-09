'use strict';

const { randomUUID } = require('crypto');

/**
 * Référentiel des CODES D'APPARTEMENT, et son catalogue standard.
 *
 * ── Pourquoi ──────────────────────────────────────────────────────────────
 * Le code d'appartement était un CHAMP LIBRE sur le mobile. Le client a
 * demandé la même mécanique que pour les niveaux : « mettez une liste des
 * appartements : A001, A002, A003 jusqu'à A015 », servie par le serveur, avec
 * un « + » pour ajouter ce qui manque.
 *
 * Un champ libre produit des jeux de codes divergents dès le deuxième
 * utilisateur — « A001 », « A-001 », « Appt 1 » désignent le même logement
 * sans qu'aucune liste ne puisse plus les rapprocher.
 *
 * ── Ce que fait cette migration ───────────────────────────────────────────
 * 1. crée `codes_appartement` ;
 * 2. l'amorce avec le catalogue STANDARD demandé : A001 → A015,
 *    `organisation_id = NULL`, donc visible de toutes les organisations.
 *
 * ── Ce qu'elle NE fait PAS ────────────────────────────────────────────────
 * Elle ne touche à AUCUNE donnée existante. Les zones déjà créées gardent le
 * nom qu'elles portent, quel qu'il soit : ce référentiel sert la SAISIE, il
 * ne réécrit pas l'historique. Un appartement nommé « Appt 3 » avant cette
 * version reste « Appt 3 ».
 *
 * ── Unicité ───────────────────────────────────────────────────────────────
 * Deux index PARTIELS, comme pour `codes_niveau` : un index unique ordinaire
 * sur (organisation_id, code) laisserait passer des doublons dans le
 * catalogue standard, PostgreSQL ne considérant jamais deux NULL comme égaux.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` retire la table. Aucune perte au-delà de ce que la migration a
 * créé — les appartements eux-mêmes vivent dans `zones`.
 */

/**
 * Catalogue STANDARD : A001 → A015, exactement la plage demandée.
 *
 * Sa portée est délibérément modeste. Un immeuble qui compte 40 logements, ou
 * qui numérote par bâtiment (« B12 »), ajoute ses codes depuis le mobile —
 * c'est précisément ce que ce référentiel rend possible.
 */
function catalogueStandard() {
  const lignes = [];
  for (let i = 1; i <= 15; i += 1) {
    const numero = String(i).padStart(3, '0');
    lignes.push({ code: `A${numero}`, nom: `Appartement ${numero}`, ordre: i });
  }
  return lignes;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('codes_appartement', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        organisation_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'organisations', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        code: { type: Sequelize.STRING(20), allowNull: false },
        nom: { type: Sequelize.STRING(100), allowNull: true },
        ordre: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        actif: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
      }, { transaction: t });

      await queryInterface.addIndex('codes_appartement', ['organisation_id'], {
        name: 'codes_appartement_organisation_id', transaction: t,
      });
      await queryInterface.addIndex('codes_appartement', ['actif'], {
        name: 'codes_appartement_actif', transaction: t,
      });

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX codes_appartement_standard_unique
           ON codes_appartement (code)
           WHERE organisation_id IS NULL AND deleted_at IS NULL`,
        { transaction: t }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX codes_appartement_organisation_unique
           ON codes_appartement (organisation_id, code)
           WHERE organisation_id IS NOT NULL AND deleted_at IS NULL`,
        { transaction: t }
      );

      const maintenant = new Date();
      await queryInterface.bulkInsert(
        'codes_appartement',
        catalogueStandard().map((ligne) => ({
          id: randomUUID(),
          organisation_id: null,
          code: ligne.code,
          nom: ligne.nom,
          ordre: ligne.ordre,
          actif: true,
          created_at: maintenant,
          updated_at: maintenant,
        })),
        { transaction: t }
      );

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('codes_appartement');
  },
};
