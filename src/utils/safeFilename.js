'use strict';

/**
 * Assainit un nom de fichier avant injection dans un en-tête Content-Disposition.
 * Empêche le header-injection (CR/LF) et les caractères dangereux (guillemets…).
 */
function safeFilename(name) {
  const nettoye = String(name == null ? 'fichier' : name)
    .replace(/["\r\n]+/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  return nettoye || 'fichier';
}

module.exports = safeFilename;
