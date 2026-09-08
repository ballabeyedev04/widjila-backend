'use strict';

/**
 * Tests — le TITULAIRE de l'abonnement peut le gérer.
 *
 * ## Le défaut
 *
 * L'inscription publique crée l'organisation et son premier compte, à qui elle
 * donne le rôle 'Entreprise' (auth.service.js#register). Ce compte est le
 * titulaire : c'est lui qui doit régler l'abonnement.
 *
 * Or 'Entreprise' n'appartient pas au groupe GESTION, qui gardait toutes les
 * routes de facturation. Conséquence, à la fin de l'essai : un mur
 * d'abonnement, un bouton « Choisir » bien visible sur le mobile comme sur le
 * web, et un 403 derrière. L'entreprise ne pouvait pas payer le produit —
 * aucune issue sans passer par le support.
 *
 * Son historique de paiements lui était fermé pour la même raison ; l'écran
 * d'abonnement du mobile masquait la section entière pour ce rôle.
 *
 * ## Ce que ces tests verrouillent
 *
 * 1. Le titulaire peut lire son historique, souscrire, changer de formule et
 *    résilier.
 * 2. Un rôle EXTÉRIEUR à la facturation ne le peut toujours pas — c'est la
 *    raison d'être de la garde : sans elle, un compte 'Client' résiliait
 *    l'abonnement et mettait toute l'organisation en lecture seule.
 * 3. Le cloisonnement tient : ces routes lisent l'organisation dans le JETON,
 *    jamais dans la requête.
 */

const path = require('path');
const fs = require('fs');

const { FACTURATION, GESTION } = require('../config/roles.js');

const ROUTE = path.join(__dirname, '..', 'modules', 'subscription', 'route', 'subscription.route.js');
const CONTROLLER = path.join(__dirname, '..', 'modules', 'subscription', 'controller', 'subscription.controller.js');

const source = fs.readFileSync(ROUTE, 'utf8');
const sourceControleur = fs.readFileSync(CONTROLLER, 'utf8');

/** Le bloc de code d'une route, du chemin jusqu'au `);` qui la ferme. */
function blocDeRoute(chemin) {
  const debut = source.indexOf(`'${chemin}'`);
  if (debut === -1) return null;
  const fin = source.indexOf(');', debut);
  return source.slice(debut, fin);
}

describe('le groupe FACTURATION', () => {
  it("inclut le compte créé par l'inscription publique", () => {
    // `register` pose ce rôle en dur ; c'est lui le titulaire.
    expect(FACTURATION).toContain('Entreprise');
  });

  it('conserve tout ce que GESTION couvrait', () => {
    // Élargir ne doit RIEN retirer : les rôles de gestion gardent la main sur
    // la facturation de leur organisation.
    for (const role of GESTION) {
      expect(FACTURATION).toContain(role);
    }
  });

  it("n'ouvre la facturation à aucun autre rôle", () => {
    // La garde existe pour eux : un compte 'Client' — souvent un intervenant
    // extérieur — pouvait résilier l'abonnement de toute l'organisation.
    const dehors = ['Client', 'SousTraitant', 'ConducteurTravaux', 'BureauControle', 'MaitreOeuvre', 'Pilote'];
    for (const role of dehors) {
      expect(FACTURATION).not.toContain(role);
    }
  });
});

describe('les routes de facturation', () => {
  // Payer est le geste qui lève le mur de fin d'essai : c'est celui dont le
  // refus coûte le plus cher.
  const routes = ['/historique', '/payment-intent', '/change-plan', '/cancel'];

  it.each(routes)('%s est gardée par FACTURATION', (chemin) => {
    const bloc = blocDeRoute(chemin);
    expect(bloc).not.toBeNull();
    expect(bloc).toContain('requireRole(...FACTURATION)');
  });

  it.each(routes)('%s exige toujours un compte authentifié et actif', (chemin) => {
    // Élargir le rôle ne doit pas relâcher le reste : sans `checkActiveUser`,
    // un compte suspendu continuerait d'engager des dépenses.
    const bloc = blocDeRoute(chemin);
    expect(bloc).toContain('auth');
    expect(bloc).toContain('checkActiveUser');
  });

  it('le webhook Stripe reste hors de toute garde de rôle', () => {
    // Stripe n'a pas de compte : lui demander un rôle le ferait échouer, et
    // les paiements ne seraient jamais confirmés.
    const bloc = blocDeRoute('/webhook');
    expect(bloc).not.toContain('requireRole');
    expect(bloc).toContain('rawBodyMiddleware');
  });
});

describe('cloisonnement', () => {
  it("l'organisation vient du JETON, jamais du corps ni de la requête", () => {
    // C'est ce qui rend l'élargissement sans danger : un compte 'Entreprise'
    // n'atteint que SA facturation, quoi qu'il envoie.
    // On lit l'APPEL ENTIER, pas la ligne : un appel réparti sur plusieurs
    // lignes — ce qu'impose un argument de plus — laisserait sinon passer
    // n'importe quoi, et le test se croirait vert. Sans expression
    // rationnelle : une découpe simple se relit sans effort.
    const methodes = [
      'getHistorique', 'creerPaymentIntent', 'changerPlan',
      'annulerAbonnement', 'getStatus', 'getPlanDetails',
    ];

    const appels = [];
    for (const methode of methodes) {
      const ancre = `SubscriptionService.${methode}(`;
      let i = sourceControleur.indexOf(ancre);
      while (i !== -1) {
        const fin = sourceControleur.indexOf(');', i);
        appels.push(sourceControleur.slice(i + ancre.length, fin));
        i = sourceControleur.indexOf(ancre, fin);
      }
    }

    expect(appels.length).toBeGreaterThanOrEqual(5);
    for (const appel of appels) {
      expect(appel).toContain('req.user.organisationId');
      expect(appel).not.toContain('req.body.organisationId');
      expect(appel).not.toContain('req.query.organisationId');
    }
  });
});
