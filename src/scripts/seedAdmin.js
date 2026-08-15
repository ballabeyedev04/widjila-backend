'use strict';

const sequelize = require('../config/db.js');
const seedAdmin = require('../seeders/adminSeeder.js');

(async () => {
  try {
    await sequelize.authenticate();
    await seedAdmin();
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Erreur seed admin:', err.message);
    process.exit(1);
  }
})();
