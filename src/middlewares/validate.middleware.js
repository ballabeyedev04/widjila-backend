'use strict';

const { ValidationError } = require('../errors/AppError.js');
const logger = require('../utils/logger.js');

/**
 * Clés systématiquement présentes dans les requêtes sans jamais appartenir aux
 * schémas métier : les signaler serait du bruit permanent.
 */
const CLES_IGNOREES = new Set(['_', '__proto__']);

/**
 * Signale les champs retirés par `stripUnknown`.
 *
 * `stripUnknown: true` est le bon réflexe de sécurité — il empêche un client
 * d'injecter des colonnes non prévues. Mais il a un revers coûteux : une faute
 * de frappe côté client (`dateDebut` au lieu de `date_debut`) ne produit AUCUNE
 * erreur, la donnée disparaît simplement. Plusieurs bugs de ce type ont vécu
 * longtemps dans ce projet — chantiers et phases enregistrés sans leurs dates,
 * champs d'organisation jamais persistés.
 *
 * On journalise donc systématiquement l'écart pour le rendre visible — EN
 * PRODUCTION AUSSI (audit — Cohérence API back/admin §7) : c'est justement en
 * production, après un changement de schéma non répercuté d'un côté ou
 * l'autre, qu'une désynchronisation silencieuse coûte le plus cher à
 * diagnostiquer. Un simple `logger.warn` ; le comportement de l'API (champs
 * retirés par `stripUnknown`) reste strictement inchangé — on ne fait que le
 * rendre visible dans les logs, en dev comme en prod.
 */
const signalerChampsIgnores = (source, recu, valide, chemin) => {
  if (!recu || typeof recu !== 'object' || Array.isArray(recu)) return;

  const retirees = Object.keys(recu).filter(
    (cle) => !CLES_IGNOREES.has(cle) && !(cle in (valide || {}))
  );
  if (retirees.length === 0) return;

  logger.warn(
    `[validate] ${chemin} — champ(s) ${source} ignoré(s) car absent(s) du schéma : `
    + `${retirees.join(', ')}. Vérifiez le nom côté client (snake_case attendu) `
    + 'ou complétez le schéma Joi.'
  );
};

/**
 * Valide req[source] (body, query, params) contre un schéma Joi.
 * En cas d'échec → ValidationError (422) avec la liste des messages.
 * En cas de succès, remplace la source par la valeur nettoyée/convertie.
 *
 * Usage : router.post('/login', validate(loginSchema), controller)
 */
const validate = (schema, source = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(req[source], {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    return next(new ValidationError('Données invalides', error.details.map((d) => d.message)));
  }

  signalerChampsIgnores(source, req[source], value, `${req.method} ${req.originalUrl}`);

  if (source === 'query') {
    Object.assign(req.query, value);
  } else {
    req[source] = value;
  }
  next();
};

module.exports = validate;
