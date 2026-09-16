'use strict';

const { creerPaymentIntentSchema } = require('../modules/subscription/validation/subscription.validation.js');

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
