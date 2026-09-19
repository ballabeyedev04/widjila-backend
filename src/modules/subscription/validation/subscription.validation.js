'use strict';

const Joi = require('joi');

// Identifiant (UUID) OU code de formule du catalogue (essentiel, pro,
// entreprise…) : le service (`creerPaymentIntent`) accepte les deux et vérifie
// lui-même en base que la formule existe, est active et a un prix.
//
// L'ancienne liste figée `valid('starter', 'pro', 'business')` datait d'avant
// le catalogue en base : elle refusait en 422 tout UUID — c'est-à-dire
// EXACTEMENT ce que le web envoie (`selectedPlan.id`) — et tout code récent.
// Le parcours mobile → navigateur aboutissait donc à « Données invalides »
// juste après avoir réussi le transfert de session. Le même correctif avait
// déjà été appliqué à paytech.validation.js, pas ici.
//
// 36 caractères : la longueur d'un UUID, borne haute des deux formes.
const creerPaymentIntentSchema = Joi.object({
  planId: Joi.string().trim().pattern(/^[a-zA-Z0-9-]{1,36}$/).required(),
});

// Référence de session Checkout (`cs_test_…` / `cs_live_…`) ou de
// PaymentIntent (`pi_…`), facultative. Bornée : c'est un identifiant Stripe,
// pas un texte libre.
const etatPaiementSchema = Joi.object({
  reference: Joi.string().trim().pattern(/^(cs|pi)_[A-Za-z0-9_]{1,120}$/).optional(),
});

module.exports = {
  creerPaymentIntentSchema,
  etatPaiementSchema,
};
