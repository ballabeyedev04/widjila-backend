'use strict';

/**
 * Rend les opérations de schéma d'une migration IDEMPOTENTES.
 *
 * ── Le problème ─────────────────────────────────────────────────────────────
 * La migration de rattrapage `20260809000000` crée, sur une base vierge,
 * TOUTES les tables d'après les modèles ACTUELS. Les migrations suivantes,
 * écrites pour l'ancien schéma, ajoutent ensuite des colonnes, tables et
 * index… qui existent déjà. Résultat constaté sur une base PostgreSQL neuve :
 *
 *   ERROR: column "demandeur_id" of relation "chantiers" already exists
 *
 * — donc aucun nouvel environnement (préproduction, reprise après sinistre)
 * ne pouvait être monté depuis les migrations.
 *
 * ── Le remède ───────────────────────────────────────────────────────────────
 * `idempotent(queryInterface)` renvoie le même objet, dont `createTable`,
 * `addColumn` et `addIndex` ne font RIEN quand l'objet visé existe déjà.
 *
 * Le contrôle est fait AVANT l'ordre, jamais en rattrapant son erreur : dans
 * une transaction PostgreSQL, la première erreur annule la transaction entière
 * (« current transaction is aborted »), même si JavaScript l'intercepte.
 *
 * Sur une base existante (production), ces migrations sont déjà inscrites dans
 * `SequelizeMeta` et ne se rejouent jamais : ce module ne change rien pour elle.
 */

async function tableExiste(qi, table, options = {}) {
  const tables = await qi.showAllTables({ transaction: options.transaction });
  const nom = typeof table === 'string' ? table : table.tableName;
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes(nom);
}

async function indexExiste(qi, nom, options = {}) {
  const [lignes] = await qi.sequelize.query(
    'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = :nom',
    { replacements: { nom }, transaction: options.transaction }
  );
  return lignes.length > 0;
}

/** Nom par défaut que Sequelize donne à un index sans `name`. */
function nomIndexParDefaut(table, champs) {
  const noms = champs.map((c) => (typeof c === 'string' ? c : c.name || c.attribute));
  return `${table}_${noms.join('_')}`.replace(/[^\w]+/g, '_').toLowerCase();
}

function idempotent(qi) {
  return new Proxy(qi, {
    get(cible, prop) {
      if (prop === 'createTable') {
        return async (table, attributs, options = {}) => {
          if (await tableExiste(cible, table, options)) return undefined;
          return cible.createTable(table, attributs, options);
        };
      }
      if (prop === 'addColumn') {
        return async (table, colonne, definition, options = {}) => {
          const description = await cible.describeTable(table, { transaction: options.transaction });
          if (description[colonne]) return undefined;
          return cible.addColumn(table, colonne, definition, options);
        };
      }
      if (prop === 'addIndex') {
        return async (table, champsOuOptions, optionsSupp = {}) => {
          // Deux signatures : addIndex(table, ['a','b'], {name}) ou addIndex(table, {fields, name}).
          const options = Array.isArray(champsOuOptions)
            ? { ...optionsSupp, fields: champsOuOptions }
            : { ...champsOuOptions, ...optionsSupp };
          const nom = options.name || nomIndexParDefaut(table, options.fields || []);
          if (await indexExiste(cible, nom, options)) return undefined;
          return cible.addIndex(table, { ...options, name: nom });
        };
      }
      const valeur = Reflect.get(cible, prop);
      return typeof valeur === 'function' ? valeur.bind(cible) : valeur;
    },
  });
}

module.exports = { idempotent, tableExiste, indexExiste, nomIndexParDefaut };
