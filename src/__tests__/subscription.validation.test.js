'use strict';

const { creerPaymentIntentSchema, etatPaiementSchema } = require('../modules/subscription/validation/subscription.validation.js');

/**
 * Le schéma de `POST /abonnement/payment-intent` figeait trois codes
 * (starter/pro/business) hérités d'avant le catalogue en base. Le web envoie
 * l'UUID de la formule, le mobile son code : les deux étaient refusés en 422
 * — « Données invalides » — juste après un transfert de session réussi. C'est
 * le service qui vérifie l'existence de la formule ; le schéma ne doit
 * refuser que ce qui ne peut être ni un UUID ni un code.
 */
describe('creerPaymentIntentSchema — identifiant OU code de formule', () => {
  it('accepte l’UUID d’une formule (ce que le web envoie)', () => {
    const { error } = creerPaymentIntentSchema.validate({ planId: '3f2b9c1e-8a4d-4c7b-9e2f-1a2b3c4d5e6f' });
    expect(error).toBeUndefined();
  });

  it.each(['essentiel', 'pro', 'entreprise'])('accepte le code « %s » du catalogue actuel', (code) => {
    const { error } = creerPaymentIntentSchema.validate({ planId: code });
    expect(error).toBeUndefined();
  });

  it('ne dépend plus de l’ancienne liste figée starter/pro/business', () => {
    // « business » n'existe plus au catalogue, mais ce n'est pas au schéma de
    // le savoir : il passe, et c'est le service qui répondra « Formule inconnue ».
    const { error } = creerPaymentIntentSchema.validate({ planId: 'business' });
    expect(error).toBeUndefined();
  });

  it('refuse une valeur qui ne peut être ni un UUID ni un code', () => {
    expect(creerPaymentIntentSchema.validate({ planId: '' }).error).toBeDefined();
    expect(creerPaymentIntentSchema.validate({ planId: 'a'.repeat(37) }).error).toBeDefined();
    expect(creerPaymentIntentSchema.validate({ planId: 'pro; DROP TABLE' }).error).toBeDefined();
    expect(creerPaymentIntentSchema.validate({}).error).toBeDefined();
  });
});

describe('etatPaiementSchema — la référence de session est un identifiant Stripe, pas un texte libre', () => {
  it.each(['cs_test_a1B2c3D4e5', 'cs_live_x9', 'pi_3Nabc123'])('accepte %s', (reference) => {
    expect(etatPaiementSchema.validate({ reference }).error).toBeUndefined();
  });

  it('accepte l’absence de référence (dernier paiement de l’organisation)', () => {
    expect(etatPaiementSchema.validate({}).error).toBeUndefined();
  });

  it.each(['', 'abc', "cs_test_1' OR 1=1", 'cs_' + 'a'.repeat(200), 'sub_123'])('refuse « %s »', (reference) => {
    expect(etatPaiementSchema.validate({ reference }).error).toBeDefined();
  });
});
