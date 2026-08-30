'use strict';

/**
 * Tests — gardes d'abonnement posées sur les routes.
 *
 * `abonnement.droits.test.js` vérifie la DÉCISION (le service). Ici on vérifie
 * son APPLICATION, c'est-à-dire ce qui protège réellement l'API d'un appel
 * direct :
 *
 *   1. le refus porte le CODE attendu — le client s'y branche pour proposer
 *      « Voir les abonnements », un message libre ne s'exploite pas ;
 *   2. le super-admin plateforme traverse les gardes, sans quoi il perdrait
 *      l'administration qu'il exerce ;
 *   3. la limite est vérifiée AVANT le contrôleur : `next()` ne doit pas être
 *      atteint quand le plafond est dépassé, sinon la ressource est créée puis
 *      refusée — et reste en base ;
 *   4. un import en masse compte le nombre RÉEL d'éléments, pas 1.
 */

jest.mock('../modules/subscription/service/droits.service.js', () => ({
  peutUtiliser: jest.fn(),
  verifierLimite: jest.fn(),
}));

const DroitsService = require('../modules/subscription/service/droits.service.js');
const {
  requireFonctionnalite, verifierLimite,
} = require('../middlewares/requireFonctionnalite.middleware.js');

const requete = (user) => ({ user });

/** Exécute un middleware et rend ce qui a été passé à `next()`. */
async function lancer(middleware, req) {
  let recu;
  let appele = false;
  await middleware(req, {}, (err) => {
    appele = true;
    recu = err;
  });
  return { appele, erreur: recu };
}

const MEMBRE = { role: 'ChefDeProjet', organisationId: 'org-1' };

beforeEach(() => jest.clearAllMocks());

describe('requireFonctionnalite', () => {
  it('laisse passer quand la formule inclut la fonctionnalité', async () => {
    DroitsService.peutUtiliser.mockResolvedValue({
      autorise: true, droits: { planNom: 'Pro' },
    });

    const req = requete(MEMBRE);
    const { erreur } = await lancer(requireFonctionnalite('rapports'), req);

    expect(erreur).toBeUndefined();
    // Les droits sont attachés à la requête : le contrôleur les relit sans
    // refaire l'appel.
    expect(req.droitsAbonnement).toEqual({ planNom: 'Pro' });
  });

  it('refuse avec SUBSCRIPTION_FEATURE_UNAVAILABLE hors formule', async () => {
    DroitsService.peutUtiliser.mockResolvedValue({
      autorise: false,
      raison: 'SUBSCRIPTION_FEATURE_UNAVAILABLE',
      droits: { planNom: 'Essentiel' },
    });

    const { erreur } = await lancer(requireFonctionnalite('rapports'), requete(MEMBRE));

    expect(erreur.code).toBe('SUBSCRIPTION_FEATURE_UNAVAILABLE');
    expect(erreur.statusCode).toBe(403);
    // Le message nomme la formule en cours : « pas inclus » sans dire dans
    // quoi n'aide pas le client à choisir.
    expect(erreur.message).toContain('Essentiel');
  });

  it('refuse avec SUBSCRIPTION_REQUIRED sans abonnement ni essai', async () => {
    DroitsService.peutUtiliser.mockResolvedValue({
      autorise: false, raison: 'SUBSCRIPTION_REQUIRED', droits: {},
    });

    const { erreur } = await lancer(requireFonctionnalite('rapports'), requete(MEMBRE));

    expect(erreur.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('laisse passer le super-admin plateforme sans consulter les droits', async () => {
    const { erreur } = await lancer(
      requireFonctionnalite('rapports'), requete({ role: 'Admin' })
    );

    expect(erreur).toBeUndefined();
    expect(DroitsService.peutUtiliser).not.toHaveBeenCalled();
  });

  it('transmet une panne du service à la chaîne d’erreurs', async () => {
    // Une base indisponible ne doit surtout pas se traduire par un accès
    // accordé : l'erreur remonte, la requête échoue.
    DroitsService.peutUtiliser.mockRejectedValue(new Error('base injoignable'));

    const { erreur } = await lancer(requireFonctionnalite('rapports'), requete(MEMBRE));

    expect(erreur).toBeInstanceOf(Error);
    expect(erreur.message).toBe('base injoignable');
  });
});

describe('verifierLimite', () => {
  it('laisse passer sous le plafond', async () => {
    DroitsService.verifierLimite.mockResolvedValue({
      autorise: true, droits: { planNom: 'Pro' },
    });

    const { erreur } = await lancer(verifierLimite('utilisateurs'), requete(MEMBRE));

    expect(erreur).toBeUndefined();
  });

  it('refuse avec SUBSCRIPTION_LIMIT_REACHED et chiffre le plafond', async () => {
    DroitsService.verifierLimite.mockResolvedValue({
      autorise: false,
      raison: 'SUBSCRIPTION_LIMIT_REACHED',
      limite: 2,
      courant: 2,
      droits: { planNom: 'Essentiel' },
    });

    const { erreur } = await lancer(verifierLimite('utilisateurs'), requete(MEMBRE));

    expect(erreur.code).toBe('SUBSCRIPTION_LIMIT_REACHED');
    expect(erreur.message).toContain('2');
    expect(erreur.message).toContain('utilisateurs');
  });

  it('compte le nombre réel d’éléments d’un import en masse', async () => {
    DroitsService.verifierLimite.mockResolvedValue({ autorise: true, droits: {} });

    const req = requete(MEMBRE);
    req.body = { membres: [{}, {}, {}] };
    await lancer(verifierLimite('utilisateurs', (r) => r.body.membres.length), req);

    expect(DroitsService.verifierLimite).toHaveBeenCalledWith('org-1', 'utilisateurs', 3);
  });

  it('retombe sur 1 quand le calcul rend une valeur vide', async () => {
    // Un tableau absent donnerait `undefined`, donc une vérification à zéro
    // élément : toujours autorisée, et le plafond ne servirait plus à rien.
    DroitsService.verifierLimite.mockResolvedValue({ autorise: true, droits: {} });

    const req = requete(MEMBRE);
    req.body = {};
    await lancer(verifierLimite('utilisateurs', (r) => (r.body.membres || []).length), req);

    expect(DroitsService.verifierLimite).toHaveBeenCalledWith('org-1', 'utilisateurs', 1);
  });

  it('laisse passer le super-admin plateforme', async () => {
    const { erreur } = await lancer(verifierLimite('chantiers'), requete({ role: 'Admin' }));

    expect(erreur).toBeUndefined();
    expect(DroitsService.verifierLimite).not.toHaveBeenCalled();
  });
});
