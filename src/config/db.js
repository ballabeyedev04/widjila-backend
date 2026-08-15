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

    dialectOptions: {
      ...(sslConfig ? { ssl: sslConfig } : {}),
      // Timeout de connexion TCP (ms) — évite un hang indéfini si la DB est inaccessible
      connectTimeout: 10000,
    },

    // Pool par PROCESS (pas global) — en mode cluster, chaque worker a son
    // propre pool de cette taille. Total de connexions DB = DB_POOL_MAX ×
    // workers, à garder nettement sous max_connections de PostgreSQL.
    pool: {
      max:     parseInt(process.env.DB_POOL_MAX || '20', 10),
      min:     parseInt(process.env.DB_POOL_MIN || '2', 10),
      acquire: 30000,
      idle:    10000,
    },

    define: { freezeTableName: true },
  }
);

module.exports = sequelize;
