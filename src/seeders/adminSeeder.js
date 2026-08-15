const bcrypt = require('bcryptjs');
const Utilisateur = require('../models/utilisateur.model.js');
const { bcryptConfig } = require('../config/security.js');
const logger = require('../utils/logger.js');

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const motDePasse = process.env.ADMIN_PASSWORD;
  const nom = process.env.ADMIN_NOM || 'Super';
  const prenom = process.env.ADMIN_PRENOM || 'Admin';

  if (!email || !motDePasse) {
    logger.warn('ADMIN_EMAIL ou ADMIN_PASSWORD non défini — admin par défaut non créé');
    return;
  }

  const exist = await Utilisateur.findOne({ where: { email: email.toLowerCase() } });
  if (exist) {
    logger.info('Admin par défaut déjà existant, aucune action effectuée');
    return;
  }

  const hashedPassword = await bcrypt.hash(motDePasse, bcryptConfig.saltRounds);

  await Utilisateur.create({
    nom,
    prenom,
    email: email.toLowerCase(),
    mot_de_passe: hashedPassword,
    // Super-admin plateforme : pas d'organisation, accès total
    role: 'Admin',
    statut: 'actif',
    permissions: ['all'],
    email_verifie: true,
  });

  logger.info(`Admin par défaut créé : ${email}`);
}

module.exports = seedAdmin;
