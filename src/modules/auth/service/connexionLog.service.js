'use strict';

const { ConnexionLog } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');

/**
 * Journal d'audit des connexions (module 1 / cahier des charges § Connexion).
 * Enregistré sur chaque tentative de connexion : succès, échec, MFA.
 * Best-effort : une panne de journalisation ne doit jamais bloquer le login.
 */
async function journaliserConnexion({ utilisateurId = null, email = null, succes, type = 'password', meta = {}, donnees = null }) {
  try {
    await ConnexionLog.create({
      utilisateurId,
      email,
      succes,
      type,
      ip: meta.ip || null,
      userAgent: meta.userAgent || null,
      donnees,
    });
  } catch (err) {
    logger.warn('[connexion] journalisation impossible :', err.message);
  }
}

module.exports = { journaliserConnexion };
