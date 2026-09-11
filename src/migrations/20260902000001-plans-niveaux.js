'use strict';

const { randomUUID } = require('crypto');
const { idempotent } = require('../utils/migrationIdempotente.js');

/**
 * Fondation du parcours « Envoi de plans ».
 *
 * ── Ce que fait cette migration ───────────────────────────────────────────
 * 1. ajoute `plans.statut` — un plan joint à une demande attend la même
 *    validation que le chantier ;
 * 2. ajoute `etages.type_niveau`, `etages.code_niveau` et
 *    `etages.description` — la nature du niveau (sous-sol / étage / toiture),
 *    son code et le texte saisi au dépôt ;
 * 3. crée `codes_niveau` et l'amorce avec un catalogue STANDARD.
 *
 * ── Pourquoi `type_niveau` ────────────────────────────────────────────────
 * `etages.niveau` est une COTE (entier). Elle ne dit pas qu'un niveau est une
 * toiture : jusqu'ici le mobile cherchait le mot « toiture » dans le nom, ce
 * qui échouait dès qu'un client écrivait « Terrasse » ou « Combles ». Les
 * trois sections de l'écran de dépôt reposent sur cette colonne.
 *
 * ── Ce que la migration NE fait PAS ───────────────────────────────────────
 * Elle ne devine RIEN sur les données existantes. Tous les étages déjà en
 * base reçoivent `type_niveau = 'etage'` (le défaut de la colonne), y compris
 * ceux dont le nom contient « sous-sol » : classer d'après un nom libre
 * produirait des erreurs silencieuses, et un niveau mal classé est plus
 * coûteux à repérer qu'un niveau non classé. La reprise éventuelle appartient
 * au client, qui seul connaît ses chantiers.
 *
 * Les plans existants reçoivent `actif` : ils précèdent le circuit, ils sont
 * exploitables.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` retire les colonnes et la table. Aucune perte au-delà de ce que la
 * migration a créé.
 */

/**
 * Catalogue STANDARD des codes de niveau, `organisation_id = NULL`.
 *
 * Sa portée est délibérément modeste : les cas courants du bâtiment français,
 * pas une tentative d'exhaustivité. Un chantier qui monte à R+40 ou descend à
 * SS6 ajoute ses codes depuis le mobile — c'est précisément ce que ce
 * référentiel rend possible.
 *
 * `ordre` suit la réalité PHYSIQUE, du plus bas au plus haut : c'est l'ordre
 * dans lequel un conducteur de travaux lit ses niveaux, et l'ordre
 * alphabétique placerait « R+10 » entre « R+1 » et « R+2 ».
 */
function catalogueStandard() {
  const lignes = [];
  let ordre = 0;

  // Sous-sols : du plus profond au plus proche du sol.
  for (let i = 3; i >= 1; i -= 1) {
    lignes.push({ typeNiveau: 'sous_sol', code: `SS${i}`, nom: `Sous-sol ${i}`, ordre: ordre++ });
  }

  lignes.push({ typeNiveau: 'etage', code: 'RDC', nom: 'Rez-de-chaussée', ordre: ordre++ });
  // Entresol : fréquent, et sans code évident pour qui ne l'a jamais saisi.
  lignes.push({ typeNiveau: 'etage', code: 'ENT', nom: 'Entresol', ordre: ordre++ });
  for (let i = 1; i <= 10; i += 1) {
    lignes.push({ typeNiveau: 'etage', code: `R+${i}`, nom: `Étage ${i}`, ordre: ordre++ });
  }

  // Toiture — vocabulaire vérifié auprès de sources du bâtiment : la
  // toiture-terrasse, les combles, les édicules et les locaux techniques sont
  // les niveaux réellement dessinés. L'acrotère n'y figure pas : c'est un
  // détail de rive, pas un niveau.
  lignes.push({ typeNiveau: 'toiture', code: 'TOIT', nom: 'Toiture-terrasse', ordre: ordre++ });
  lignes.push({ typeNiveau: 'toiture', code: 'COMB', nom: 'Combles', ordre: ordre++ });
  lignes.push({ typeNiveau: 'toiture', code: 'EDIC', nom: 'Édicule', ordre: ordre++ });
  lignes.push({ typeNiveau: 'toiture', code: 'LTEC', nom: 'Local technique', ordre: ordre++ });

  return lignes;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // Base vierge : colonnes et table déjà créées d'après les modèles par
    // 20260809000000 — voir utils/migrationIdempotente.js.
    queryInterface = idempotent(queryInterface);
    const t = await queryInterface.sequelize.transaction();
    try {
      // ── 1. Statut des plans ───────────────────────────────────────────────
      await queryInterface.addColumn('plans', 'statut', {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'actif',
      }, { transaction: t });

      await queryInterface.addIndex('plans', ['statut'], {
        name: 'plans_statut',
        transaction: t,
      });

      // ── 2. Nature, code et description du niveau ──────────────────────────
      await queryInterface.addColumn('etages', 'type_niveau', {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'etage',
      }, { transaction: t });

      await queryInterface.addColumn('etages', 'code_niveau', {
        type: Sequelize.STRING(20),
        allowNull: true,
      }, { transaction: t });

      await queryInterface.addColumn('etages', 'description', {
        type: Sequelize.TEXT,
        allowNull: true,
      }, { transaction: t });

      await queryInterface.addIndex('etages', ['type_niveau'], {
        name: 'etages_type_niveau',
        transaction: t,
      });

      // ── 3. Référentiel des codes de niveau ────────────────────────────────
      await queryInterface.createTable('codes_niveau', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        organisation_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'organisations', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        type_niveau: { type: Sequelize.STRING(20), allowNull: false },
        code: { type: Sequelize.STRING(20), allowNull: false },
        nom: { type: Sequelize.STRING(100), allowNull: true },
        ordre: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        actif: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
      }, { transaction: t });

      await queryInterface.addIndex('codes_niveau', ['organisation_id'], {
        name: 'codes_niveau_organisation_id', transaction: t,
      });
      await queryInterface.addIndex('codes_niveau', ['type_niveau'], {
        name: 'codes_niveau_type_niveau', transaction: t,
      });

      // Unicité PARTIELLE, en deux index — le catalogue standard
      // (`organisation_id IS NULL`) et les codes propres à une organisation
      // ne se contraignent pas de la même façon : un index unique ordinaire
      // sur (organisation_id, type_niveau, code) laisserait passer des
      // doublons dans le standard, PostgreSQL ne considérant jamais deux NULL
      // comme égaux.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS codes_niveau_standard_unique
           ON codes_niveau (type_niveau, code)
           WHERE organisation_id IS NULL AND deleted_at IS NULL`,
        { transaction: t }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS codes_niveau_organisation_unique
           ON codes_niveau (organisation_id, type_niveau, code)
           WHERE organisation_id IS NOT NULL AND deleted_at IS NULL`,
        { transaction: t }
      );

      const maintenant = new Date();
      await queryInterface.bulkInsert('codes_niveau', catalogueStandard().map((c) => ({
        id: randomUUID(),
        organisation_id: null,
        type_niveau: c.typeNiveau,
        code: c.code,
        nom: c.nom,
        ordre: c.ordre,
        actif: true,
        created_at: maintenant,
        updated_at: maintenant,
      })), { transaction: t });

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('codes_niveau', { transaction: t });
      await queryInterface.removeIndex('etages', 'etages_type_niveau', { transaction: t });
      await queryInterface.removeColumn('etages', 'description', { transaction: t });
      await queryInterface.removeColumn('etages', 'code_niveau', { transaction: t });
      await queryInterface.removeColumn('etages', 'type_niveau', { transaction: t });
      await queryInterface.removeIndex('plans', 'plans_statut', { transaction: t });
      await queryInterface.removeColumn('plans', 'statut', { transaction: t });
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },
};
