require('dotenv').config();

/**
 * Configuration Sequelize CLI.
 * Utilisé par : npx sequelize-cli db:migrate / db:migrate:undo
 */
module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false
  },
  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false,
    dialectOptions: {
      ssl: process.env.DB_SSL_CA
        ? {
            require: true,
            rejectUnauthorized: true,
            ca: process.env.DB_SSL_CA.startsWith('-----')
              ? process.env.DB_SSL_CA
              : Buffer.from(process.env.DB_SSL_CA, 'base64').toString('utf-8')
          }
        : false
    }
  }
};
