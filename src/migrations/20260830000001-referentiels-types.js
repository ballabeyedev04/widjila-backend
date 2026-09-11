'use strict';

const { randomUUID } = require('crypto');
const {
  TYPE_DOCUMENT, TYPE_PARTENAIRE, TYPE_INSPECTION,
} = require('../config/enums.js');

/**
 * Rend administrables les types de DOCUMENT, d'INTERVENANT et d'INSPECTION.
 *
 * ── Ce que fait cette migration ───────────────────────────────────────────
 * 1. crée les trois tables de référentiel ;
 * 2. les amorce avec les valeurs de l'ancien ENUM, MÊME code, de sorte que
 *    tout ce qui est déjà en base reste valide ;
 * 3. convertit les colonnes métier d'`ENUM` en `VARCHAR(50)`.
 *
 * ── Pourquoi convertir la colonne ─────────────────────────────────────────
 * Tant qu'elle reste un `ENUM`, ajouter un type depuis l'administration
 * échoue à l'écriture : PostgreSQL refuse une valeur hors du type. La colonne
 * doit accepter n'importe quel code, la validité étant désormais vérifiée par
 * le référentiel — au moment de la saisie, là où le message est utile.
 *
 * ── Ce que la migration NE fait PAS ───────────────────────────────────────
 * Elle ne touche à AUCUNE donnée existante : `USING type::text` recopie les
 * valeurs à l'identique. Un document « pv » reste « pv ».
 *
 * Elle ne supprime pas non plus les types ENUM PostgreSQL désormais inutiles
 * (`enum_documents_type`…) : les laisser ne coûte rien, et les supprimer
 * rendrait le `down()` incapable de recréer la colonne à l'identique.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` remet les colonnes en `ENUM`. Attention : si des types ont été
 * ajoutés depuis l'administration et utilisés, la conversion inverse ÉCHOUERA
 * — c'est volontaire, mieux vaut un rollback qui refuse qu'un rollback qui
 * efface silencieusement des données.
 */

/** Libellés français des valeurs historiques — repris de utils/constants.js. */
const LIBELLES = {
  // Documents
  plan: 'Plan', contrat: 'Contrat', doe: 'DOE', pv: 'PV',
  compte_rendu: 'Compte rendu', rapport: 'Rapport', notice: 'Notice',
  photo: 'Photo', autre: 'Autre',
  // Intervenants
  client: 'Client', maitre_ouvrage: 'Maître d’ouvrage',
  maitre_oeuvre: 'Maître d’œuvre', sous_traitant: 'Sous-traitant',
  fournisseur: 'Fournisseur', bureau_controle: 'Bureau de contrôle',
  // Inspections
  inspection: 'Inspection', opr: 'OPR',
  visite_contradictoire: 'Visite contradictoire',
};

const REFERENTIELS = [
  { table: 'types_document', codes: TYPE_DOCUMENT, cible: { table: 'documents', colonne: 'type' } },
  { table: 'types_partenaire', codes: TYPE_PARTENAIRE, cible: { table: 'partenaires', colonne: 'type' } },
  { table: 'types_inspection', codes: TYPE_INSPECTION, cible: { table: 'inspections', colonne: 'type' } },
];

async function tableExiste(queryInterface, nom) {
  const tables = await queryInterface.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes(nom);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const { table, codes, cible } of REFERENTIELS) {
      // ── 1. La table ─────────────────────────────────────────────────────
      if (!(await tableExiste(queryInterface, table))) {
        await queryInterface.createTable(table, {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
            primaryKey: true,
            allowNull: false,
          },
          // NULL = catalogue standard de la plateforme.
          organisation_id: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'organisations', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          code: { type: Sequelize.STRING(50), allowNull: false },
          nom: { type: Sequelize.STRING(100), allowNull: false },
          description: { type: Sequelize.TEXT, allowNull: true },
          ordre: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          actif: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
          created_at: {
            type: Sequelize.DATE, allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updated_at: {
            type: Sequelize.DATE, allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          deleted_at: { type: Sequelize.DATE, allowNull: true },
        });

        await queryInterface.addIndex(table, ['organisation_id'], { name: `${table}_organisation` });
        await queryInterface.addIndex(table, ['actif'], { name: `${table}_actif` });
      }

      // HORS du `if` de création : sur une base vierge, la table existe déjà
      // (créée d'après le modèle par 20260809000000) et ces index uniques —
      // absents du modèle — n'étaient jamais posés. `IF NOT EXISTS` couvre
      // les deux cas.
      {
        // Unicité du CODE, séparément pour le standard et pour chaque
        // organisation : deux clients peuvent définir un « ppsps » chacun,
        // mais pas deux fois dans le même catalogue. Index PARTIELS —
        // `deleted_at IS NULL` pour qu'une suppression douce libère le code.
        await queryInterface.sequelize.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${table}_code_standard_unique
            ON ${table} (lower(code))
            WHERE organisation_id IS NULL AND deleted_at IS NULL;
        `);
        await queryInterface.sequelize.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ${table}_code_organisation_unique
            ON ${table} (organisation_id, lower(code))
            WHERE organisation_id IS NOT NULL AND deleted_at IS NULL;
        `);
      }

      // ── 2. La graine ────────────────────────────────────────────────────
      //
      // Conditionnée au CONTENU et non à l'existence de la table : un échec
      // entre la création et l'insertion laisserait sinon un référentiel vide
      // que le garde ci-dessus ferait sauter à chaque rejeu — plus aucun type
      // proposé, et rien pour le signaler.
      const [{ total }] = await queryInterface.sequelize.query(
        `SELECT COUNT(*)::int AS total FROM ${table} WHERE organisation_id IS NULL`,
        { type: queryInterface.sequelize.QueryTypes.SELECT }
      );

      if (total === 0) {
        const maintenant = new Date();
        await queryInterface.bulkInsert(table, codes.map((code, i) => ({
          id: randomUUID(),
          organisation_id: null,
          code,
          // Repli sur le code lui-même : mieux vaut un libellé technique
          // qu'une ligne sans nom, que la colonne refuserait.
          nom: LIBELLES[code] || code,
          description: null,
          ordre: (i + 1) * 10, // pas de 10 : on intercale sans renuméroter
          actif: true,
          created_at: maintenant,
          updated_at: maintenant,
          deleted_at: null,
        })));
      }

      // ── 3. La colonne métier : ENUM → VARCHAR ───────────────────────────
      //
      // `USING ... ::text` recopie les valeurs à l'identique. Sans cette
      // clause, PostgreSQL refuse la conversion.
      await queryInterface.sequelize.query(`
        ALTER TABLE ${cible.table}
          ALTER COLUMN ${cible.colonne} TYPE VARCHAR(50)
          USING ${cible.colonne}::text;
      `);
    }
  },

  async down(queryInterface) {
    // Les colonnes redeviennent des ENUM. Échoue si un type ajouté depuis
    // l'administration est utilisé — refus délibéré : voir l'en-tête.
    for (const { table, codes, cible } of REFERENTIELS) {
      const liste = codes.map((c) => `'${c}'`).join(', ');
      const nomType = `enum_${cible.table}_${cible.colonne}`;

      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${nomType}') THEN
            CREATE TYPE ${nomType} AS ENUM (${liste});
          END IF;
        END $$;
      `);
      await queryInterface.sequelize.query(`
        ALTER TABLE ${cible.table}
          ALTER COLUMN ${cible.colonne} TYPE ${nomType}
          USING ${cible.colonne}::${nomType};
      `);

      if (await tableExiste(queryInterface, table)) {
        await queryInterface.dropTable(table);
      }
    }
  },
};
