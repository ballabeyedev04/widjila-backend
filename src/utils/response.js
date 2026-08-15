/**
 * Helpers pour des réponses API cohérentes.
 *
 * Format succès  : { success: true,  message, data }
 * Format erreur  : { success: false, message }
 *
 * Usage dans un controller :
 *   const { ok, created, fail, serverError } = require('./response.js');
 *   return ok(res, { utilisateur }, 'Profil récupéré');
 */

const ok = (res, data, message = 'Succès', status = 200) =>
  res.status(status).json({ success: true, message, data });

const created = (res, data, message = 'Créé avec succès') =>
  res.status(201).json({ success: true, message, data });

const fail = (res, message, status = 400) =>
  res.status(status).json({ success: false, message });

const serverError = (res, message = 'Erreur interne du serveur') =>
  res.status(500).json({ success: false, message });

module.exports = { ok, created, fail, serverError };
