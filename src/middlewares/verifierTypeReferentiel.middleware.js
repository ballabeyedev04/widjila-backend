'use strict';

const { parCle } = require('../modules/referentiel/typesReferentiels.js');
const { BadRequestError } = require('../errors/AppError.js');

/**
 * Vérifie qu'un `type` fourni par le client existe au référentiel.
 *
 * ── Pourquoi un middleware et non un schéma Joi ───────────────────────────
 * La liste des types acceptés vivait dans `Joi.valid(...ENUM)` : figée à la
 * compilation, elle rendait impossible tout ajout depuis l'administration.
 * Elle vit désormais en base, et seule une requête peut dire si un code est
 * valide.
 *
 * Posé AVANT le contrôleur, comme l'était la validation Joi : le refus reste
 * un 400 avec un message clair, et rien n'est écrit entre-temps.
 *
 * ── Le champ reste FACULTATIF ─────────────────────────────────────────────
 * Un `type` absent n'est pas une erreur — les schémas le marquaient déjà
 * `.optional()`, et les services appliquent leur propre valeur par défaut
 * (`autre`, `client`). Seule une valeur FOURNIE est vérifiée.
 *
 * @param {'document'|'partenaire'|'inspection'} cle référentiel à interroger
 * @param {string} [champ='type'] clé du corps de requête à contrôler
 */
function verifierTypeReferentiel(cle, champ = 'type') {
  const referentiel = parCle[cle];
  if (!referentiel) throw new Error(`Référentiel inconnu : ${cle}`);

  return async function verifier(req, res, next) {
    try {
      const valeur = req.body?.[champ];
      if (valeur === undefined || valeur === null || valeur === '') return next();

      const valide = await referentiel.service.codeValide(req.user?.organisationId, valeur);
      if (valide) return next();

      // Le message nomme le champ ET oriente vers l'écran qui permet d'y
      // remédier : « type invalide » seul laisserait l'utilisateur sans issue.
      return next(new BadRequestError(
        `« ${valeur} » n’est pas un ${referentiel.libelle} valide. `
        + 'Vérifiez le référentiel, ou ajoutez-y ce type.'
      ));
    } catch (err) {
      next(err);
    }
  };
}

module.exports = verifierTypeReferentiel;
