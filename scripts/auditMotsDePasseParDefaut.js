'use strict';

/**
 * Remédiation — comptes créés depuis la plateforme avec le mot de passe
 * par défaut « Temp1234! » (audit sécurité, gestionUtilisateur.service.js).
 *
 * Avant correctif, CHAQUE compte créé depuis l'écran « Utilisateurs » du
 * super-admin recevait ce mot de passe public (la saisie de l'écran était
 * perdue en route). Corriger le code ne corrige pas les comptes déjà créés :
 * ce script les retrouve et, sur demande, les neutralise.
 *
 * Usage :
 *   node -r dotenv/config scripts/auditMotsDePasseParDefaut.js             # lecture seule
 *   node -r dotenv/config scripts/auditMotsDePasseParDefaut.js --corriger  # neutralise
 *
 * Neutraliser = mot de passe remplacé par une valeur aléatoire que personne ne
 * connaît, jetons d'accès périmés (`token_version`), sessions révoquées. Les
 * utilisateurs concernés reprennent la main par « Mot de passe oublié ».
 * EXCEPTION : un compte `Admin` n'a pas accès à « Mot de passe oublié »
 * (account.service.js#forgotPassword) — il est signalé, et un autre
 * administrateur doit lui redéfinir un mot de passe depuis la plateforme.
 *
 * Aucun mot de passe ni adresse complète n'est affiché.
 */

const crypto = require('crypto');
const bcrypt = require('../src/utils/motDePasse.js');
const { Utilisateur, RefreshToken } = require('../src/models/index');
const { bcryptConfig } = require('../src/config/security.js');

const MOT_DE_PASSE_PUBLIC = 'Temp1234!';
const CORRIGER = process.argv.includes('--corriger');

const masquer = (email) => {
  const [local = '', domaine = ''] = String(email).split('@');
  return `${local.slice(0, 2)}***@${domaine}`;
};

(async () => {
  try {
    // Seuls les comptes encore marqués « mot de passe temporaire » peuvent
    // l'avoir gardé : un changement ou une réinitialisation lève le drapeau.
    const candidats = await Utilisateur.findAll({
      where: { mdp_temporaire: true },
      attributes: ['id', 'email', 'role', 'statut', 'mot_de_passe', 'token_version'],
    });

    const exposes = [];
    for (const u of candidats) {
      if (u.mot_de_passe && await bcrypt.compare(MOT_DE_PASSE_PUBLIC, u.mot_de_passe)) exposes.push(u);
    }

    console.log(`${candidats.length} compte(s) à mot de passe temporaire examiné(s), ${exposes.length} exposé(s).`);
    for (const u of exposes) {
      console.log(` - ${u.id}  ${u.role.padEnd(18)} ${u.statut.padEnd(22)} ${masquer(u.email)}${u.role === 'Admin' ? '   ⚠ ADMIN' : ''}`);
    }

    if (!exposes.length) process.exit(0);
    if (!CORRIGER) {
      console.log('\nLecture seule. Relancer avec --corriger pour neutraliser ces comptes.');
      process.exit(2); // code non nul : utilisable comme contrôle en CI / avant mise en production
    }

    for (const u of exposes) {
      const aleatoire = crypto.randomBytes(24).toString('base64url');
      await u.update({
        mot_de_passe: await bcrypt.hash(aleatoire, bcryptConfig.saltRounds),
        token_version: (u.token_version || 0) + 1,
        mdp_temporaire: true,
      });
      await RefreshToken.update({ revoked: true }, { where: { utilisateurId: u.id, revoked: false } });
    }
    console.log(`\n${exposes.length} compte(s) neutralisé(s). Prévenir les utilisateurs d'utiliser « Mot de passe oublié ».`);
    const admins = exposes.filter((u) => u.role === 'Admin').length;
    if (admins) console.log(`⚠ ${admins} compte(s) Admin : redéfinir leur mot de passe depuis la plateforme (pas de « Mot de passe oublié » pour ce rôle).`);
    process.exit(0);
  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
})();
