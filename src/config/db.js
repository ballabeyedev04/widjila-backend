require('dotenv').config();
const { Sequelize } = require('sequelize');

function buildSslConfig() {
  // Pas de SSL si PostgreSQL est sur le même serveur (loopback — DB_SSL_CA vide)
  if (!process.env.DB_SSL_CA || process.env.DB_SSL_CA.trim() === '') return false;

  const ssl = { require: true, rejectUnauthorized: true };
  const raw = process.env.DB_SSL_CA.trim();
  ssl.ca = raw.startsWith('-----') ? raw : Buffer.from(raw, 'base64').toString('utf-8');
  return ssl;
}

const sslConfig = buildSslConfig();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host:    process.env.DB_HOST || '127.0.0.1',
    port:    parseInt(process.env.DB_PORT || '5432', 10),
    dialect: 'postgres',
    logging: false,

    // ── Délais — CORRECTIF (audit performance) ─────────────────────────────
    // `connectTimeout` était IGNORÉ : ce n'est pas une option du pilote `pg`,
    // et Sequelize ne transmet de `dialectOptions` qu'une liste fermée de clés
    // (sequelize/lib/dialects/postgres/connection-manager.js). Il n'y avait
    // donc AUCUN délai de connexion, aucun délai de requête, et une
    // transaction oubliée ouverte (appel réseau en attente à l'intérieur)
    // gardait sa connexion indéfiniment. Les trois clés ci-dessous font partie
    // de la liste transmise — vérifié par db.configuration.perf.test.js.
    //   - connectionTimeoutMillis : base injoignable → échec en 5 s, pas un
    //     blocage jusqu'au délai TCP du système ;
    //   - statement_timeout : une requête pathologique est tuée côté serveur
    //     au lieu d'occuper une connexion (et un cœur PostgreSQL) sans fin ;
    //     30 s par défaut, au-dessus de la plus longue requête légitime
    //     (exports, purges) — surchargeable par DB_STATEMENT_TIMEOUT_MS ;
    //   - idle_in_transaction_session_timeout : une transaction restée ouverte
    //     sans rien faire est coupée, et sa connexion rendue au pool.
    dialectOptions: {
      ...(sslConfig ? { ssl: sslConfig } : {}),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '5000', 10),
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
      idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT_MS || '60000', 10),
    },

    // Pool par PROCESS (pas global) — en mode cluster, chaque worker a son
    // propre pool de cette taille. Total de connexions DB = DB_POOL_MAX ×
    // workers × instances, à garder sous max_connections de PostgreSQL moins
    // une réserve (~10) pour les migrations, psql et la supervision.
    //   VPS 4 vCPU, PM2 `instances: max` → 4 × 20 = 80 ≤ 100 − 10 : OK.
    //   8 vCPU → 8 × 20 = 160 > 100 : poser DB_POOL_MAX=11, ou pgbouncer.
    //
    // `acquire` ramené de 30 s à 10 s : quand le pool est saturé ou la base
    // tombée, une requête attendait 30 s avant d'échouer — assez pour que le
    // client abandonne, relance, et empile une seconde attente derrière la
    // première. 10 s laisse passer un pic, pas une panne.
    pool: {
      max:     parseInt(process.env.DB_POOL_MAX || '20', 10),
      min:     parseInt(process.env.DB_POOL_MIN || '2', 10),
      acquire: parseInt(process.env.DB_POOL_ACQUIRE_MS || '10000', 10),
      idle:    10000,
    },

    define: { freezeTableName: true },
  }
);

module.exports = sequelize;
