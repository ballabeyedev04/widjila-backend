'use strict';

const Joi = require('joi');
const { telephone, motDePasse, nom, prenom, email } = require('../../../validations/common.js');
const { PAYS, CHAMPS, champsDuPays } = require('../../../config/pays.js');

const registerSchema = Joi.object({
  // Utilisateur
  nom: nom.required(),
  prenom: prenom.required(),
  email: email.required(),
  mot_de_passe: motDePasse.required(),
  telephone: telephone.optional().allow('', null),
  fonction: Joi.string().trim().max(100).optional().allow('', null),
  // Organisation (entreprise) créée à l'inscription
  organisationNom: Joi.string().trim().min(2).max(150).optional().allow('', null),
  raison_sociale: Joi.string().trim().max(255).optional().allow('', null),

  // ── Identifiants d'entreprise, selon le PAYS ─────────────────────────────
  //
  // Tous sont déclarés facultatifs ici — une entreprise en cours
  // d'immatriculation n'a pas encore ses numéros, et les exiger l'empêcherait
  // de s'inscrire. Le contrôle de COHÉRENCE (un NINEA n'a rien à faire dans
  // une inscription française) est appliqué juste après par `.custom()`, qui
  // seul connaît le pays choisi.
  ...Object.fromEntries(
    Object.values(CHAMPS).map((c) => [
      c.cle,
      Joi.string().trim().max(50).optional().allow('', null),
    ])
  ),

  organisationTelephone: telephone.optional().allow('', null),
  organisationEmail: email.optional().allow('', null),
  organisationAdresse: Joi.string().trim().max(200).optional().allow('', null),
  organisationVille: Joi.string().trim().max(100).optional().allow('', null),
  // Code ISO 3166-1 alpha-2. `.valid()` ferme la porte à un pays inventé :
  // un code inconnu n'aurait aucun champ d'identification associé, et
  // l'inscription passerait sans qu'aucun identifiant ne soit vérifié.
  organisationPays: Joi.string().trim().uppercase()
    .valid(...PAYS.map((p) => p.code))
    .optional().allow('', null),
})
  .custom((valeurs, aide) => {
    const pays = valeurs.organisationPays;
    if (!pays) return valeurs;

    const autorises = champsDuPays(pays);

    for (const [cle, champ] of Object.entries(CHAMPS)) {
      const valeur = valeurs[cle];
      if (valeur === undefined || valeur === null || valeur === '') continue;

      // Identifiant sans rapport avec le pays : on REFUSE plutôt que d'ignorer
      // en silence. Une donnée acceptée puis jetée fait croire à
      // l'utilisateur qu'elle est enregistrée.
      if (!autorises.includes(cle)) {
        return aide.message(
          `Le champ « ${champ.libelle} » ne s'applique pas au pays sélectionné.`
        );
      }

      if (!new RegExp(champ.motif).test(valeur)) {
        return aide.message(`« ${champ.libelle} » est invalide — ${champ.aide}.`);
      }
    }

    return valeurs;
  });

const loginSchema = Joi.object({
  // Les bornes ne sont pas cosmétiques : sans `.max()`, une chaîne de 250 000
  // caractères atteignait la regex de détection d'email du service et bloquait
  // la boucle d'événements plusieurs minutes (ReDoS non authentifié).
  // 320 = longueur maximale d'une adresse email (RFC 5321).
  identifiant: Joi.string().trim().max(320).required(),
  mot_de_passe: Joi.string().max(128).required(),
});

// refreshToken : désormais porté par le cookie httpOnly (le body n'est qu'un
// fallback de compat) — donc optionnel dans le schéma.
const refreshSchema = Joi.object({
  refreshToken: Joi.string().optional().allow('', null),
});

const logoutSchema = Joi.object({
  refreshToken: Joi.string().optional().allow('', null),
});

// Validation du code TOTP (2e facteur) après un login MFA.
// mfaToken : porté par le cookie httpOnly (fallback body pour compat).
const mfaVerifySchema = Joi.object({
  mfaToken: Joi.string().optional().allow('', null),
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Le code de vérification doit contenir 6 chiffres',
  }),
});

// Vérification de l'email d'inscription (lien signé)
const forgotPasswordSchema = Joi.object({
  email: email.required(),
});

const resetPasswordSchema = Joi.object({
  otp: Joi.string().trim().min(6).max(6).required(),
  email: email.required(),
  nouveau_mot_de_passe: motDePasse.required(),
});

module.exports = {
  registerSchema, loginSchema, refreshSchema, logoutSchema,
  forgotPasswordSchema, resetPasswordSchema,
  mfaVerifySchema,
};
