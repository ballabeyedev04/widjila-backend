'use strict';

/**
 * Tests — les routes listées au § 11 du cahier technique Widjila.
 *
 * ```
 * POST   /api/plans/{planId}/reserves
 * PATCH  /api/reserves/{reserveId}
 * POST   /api/reserves/{reserveId}/photos
 * POST   /api/plans/{planId}/versions
 * GET    /api/plans/{planId}/reserves
 * ```
 *
 * ## Pourquoi les monter plutôt que les décrire
 *
 * Une route peut être écrite dans le fichier de routage et rester
 * inaccessible : un middleware placé avant elle, un motif plus large déclaré
 * au-dessus, un contrôleur mal exporté. Rien de tout cela ne se voit à la
 * lecture. On interroge donc l'application réellement montée.
 *
 * Les appels partent SANS jeton : on vérifie que la route EXISTE et qu'elle
 * est GARDÉE — un 401 prouve les deux à la fois. Un 404 signifierait qu'elle
 * n'est pas montée ; un 200 qu'elle est ouverte à tous.
 */

// `otplib` et `qrcode` publient du JavaScript que Jest ne sait pas transformer
// tel quel ; ils sont doublés comme dans `referentiel.route.test.js`. Aucune
// des routes vérifiées ici ne s'en sert.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

// Limiteurs neutralisés : toutes les requêtes d'un test partent de la même IP,
// et une rafale de huit appels déclencherait le plafond. Ils restent actifs en
// production, couverts par `rateLimit.sharedStore.test.js`.
jest.mock('../middlewares/rateLimit.middleware.js', () => {
  const passe = (req, res, next) => next();
  // TOUS les limiteurs exportés : `app.js` monte des routes qui en utilisent
  // six, et un seul manquant fait échouer le montage entier sur un
  // « argument handler must be a function » qui ne nomme pas le coupable.
  return {
    authRateLimit: passe,
    sessionRateLimit: passe,
    mutationRateLimit: passe,
    adminRateLimit: passe,
    otpEmailRateLimit: passe,
    authenticatedRateLimit: passe,
    rateLimitConfig: {},
  };
});

const request = require('supertest');
const app = require('../app.js');

const PLAN = '11111111-1111-4111-8111-111111111111';
const RESERVE = '22222222-2222-4222-8222-222222222222';

/**
 * Une route MONTÉE et AUTHENTIFIÉE répond 401 sans jeton.
 *
 * 404 dirait « ce chemin n'existe pas » ; 200 dirait « n'importe qui peut
 * l'appeler ». Les deux seraient des défauts, et de nature opposée.
 */
async function attendreRouteGardee(methode, chemin) {
  const reponse = await request(app)[methode](chemin);
  expect(reponse.status).toBe(401);
}

describe('§ 11 — les routes du cahier existent et sont gardées', () => {
  it('POST /plans/:id/reserves — créer une réserve depuis un plan', async () => {
    // La route du § 12 : le corps ne porte ni chantier ni plan, seulement
    // l'observation, l'entreprise, la gravité, l'échéance et les coordonnées.
    await attendreRouteGardee('post', `/api/v1/plans/${PLAN}/reserves`);
  });

  it('GET /plans/:id/reserves — les réserves d’un plan', async () => {
    await attendreRouteGardee('get', `/api/v1/plans/${PLAN}/reserves`);
  });

  it('POST /plans/:id/versions — déposer une nouvelle version', async () => {
    await attendreRouteGardee('post', `/api/v1/plans/${PLAN}/versions`);
  });

  it('GET /plans/:id/versions — l’historique des versions', async () => {
    await attendreRouteGardee('get', `/api/v1/plans/${PLAN}/versions`);
  });

  it('PATCH /reserves/:id — modification partielle', async () => {
    await attendreRouteGardee('patch', `/api/v1/reserves/${RESERVE}`);
  });

  it('POST /reserves/:id/photos — ajouter une photo', async () => {
    await attendreRouteGardee('post', `/api/v1/reserves/${RESERVE}/photos`);
  });
});

describe('les routes historiques restent servies', () => {
  // Les clients en production les utilisent : les nouvelles routes du cahier
  // sont des portes SUPPLÉMENTAIRES, jamais des remplacements.
  it('PUT /reserves/:id répond toujours', async () => {
    await attendreRouteGardee('put', `/api/v1/reserves/${RESERVE}`);
  });

  it('POST /reserves/:id/medias répond toujours', async () => {
    await attendreRouteGardee('post', `/api/v1/reserves/${RESERVE}/medias`);
  });
});

describe('§ 12 — le corps de création depuis un plan', () => {
  const {
    creerReserveSurPlanSchema,
  } = require('../modules/reserve/validation/reserve.validation.js');

  const PHASE = '33333333-3333-4333-8333-333333333333';

  it('accepte la requête de l’exemple du document', () => {
    // Le § 12 donne : observation, company_id, severity, due_date,
    // x_position, y_position, status. Transposé à nos noms de champs, avec la
    // phase que le produit impose en plus.
    const { error } = creerReserveSurPlanSchema.validate({
      titre: 'Faïence cassée dans la salle de bains',
      description: 'Faïence cassée dans la salle de bains',
      phaseId: PHASE,
      severite: 'haute',
      date_limite: '2026-09-15',
      positionX: 62.35,
      positionY: 41.8,
    });

    expect(error).toBeUndefined();
  });

  it('n’exige PAS le chantier — il vient du plan', () => {
    // C'est tout l'intérêt de la route : quand on relève un défaut, on est sur
    // un plan, et le plan sait à quel chantier il appartient.
    const { error } = creerReserveSurPlanSchema.validate({
      titre: 'Fissure',
      phaseId: PHASE,
    });

    expect(error).toBeUndefined();
  });

  it('REFUSE un `planId` dans le corps', () => {
    // Il est dans l'URL. L'accepter aussi dans le corps permettrait de poser la
    // réserve sur un AUTRE plan que celui appelé, ce qui rendrait l'URL
    // mensongère.
    const { error } = creerReserveSurPlanSchema.validate({
      titre: 'Fissure',
      phaseId: PHASE,
      planId: PLAN,
    });

    expect(error).toBeDefined();
    expect(error.message).toContain('planId');
  });

  it('borne les coordonnées comme partout ailleurs', () => {
    expect(
      creerReserveSurPlanSchema.validate({
        titre: 'Fissure', phaseId: PHASE, positionX: 145, positionY: 50,
      }).error,
    ).toBeDefined();
  });
});

describe('§ 11 — déposer une version ne renomme pas le plan', () => {
  const { deposerVersionSchema } = require('../modules/plan/validation/plan.validation.js');

  it('refuse un `nom` dans le corps', () => {
    // Le nom fait la version : il est repris du plan désigné. L'accepter
    // permettrait de renommer un plan sous couvert d'en verser une version, et
    // l'historique cesserait de décrire le même document.
    expect(deposerVersionSchema.validate({ nom: 'Autre plan' }).error).toBeDefined();
  });

  it('refuse un rattachement dans le corps', () => {
    expect(deposerVersionSchema.validate({ batimentId: PLAN }).error).toBeDefined();
  });

  it('accepte une discipline et une date — elles peuvent changer', () => {
    // Un plan corrigé porte une date plus récente, et sa discipline a pu être
    // mal saisie la première fois.
    const { error } = deposerVersionSchema.validate({
      type_plan: 'Électricité',
      date_plan: '2026-09-01',
    });

    expect(error).toBeUndefined();
  });

  it('accepte un corps VIDE — le cas courant', () => {
    expect(deposerVersionSchema.validate({}).error).toBeUndefined();
  });
});
