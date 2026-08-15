'use strict';

/**
 * Accorde le rôle Admin + permissions ['all'] (super-admin) à un utilisateur
 * existant.
 *
 * Usage : node -r dotenv/config scripts/grant-superadmin.js <email>
 */
const { Utilisateur } = require('../src/models/index');

(async () => {
  try {
    const email = process.argv[2];
    if (!email) {
      console.error('Usage : node -r dotenv/config scripts/grant-superadmin.js <email>');
      process.exit(1);
    }

    const utilisateur = await Utilisateur.findOne({ where: { email: email.toLowerCase() } });
    if (!utilisateur) {
      console.error(`Aucun utilisateur trouvé avec l'email ${email}`);
      process.exit(1);
    }

    utilisateur.role = 'Admin';
    utilisateur.permissions = ['all'];
    await utilisateur.save();

    console.log(`Super-admin accordé : ${email}`);
    process.exit(0);
  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
})();
