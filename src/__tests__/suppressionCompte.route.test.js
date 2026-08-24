'use strict';

/**
 * Route PUBLIQUE de dépôt d'une demande de suppression de compte.
 *
 * Ce qui est vérifié ici tient à l'exigence Google Play et au RGPD :
 * l'endpoint doit répondre SANS aucun jeton d'authentification, et valider
 * ses entrées puisqu'il est ouvert à Internet.
 *
 * Le modèle et l'envoi d'email sont simulés : le test porte sur le contrat
 * HTTP (accessibilité, validation, forme de la réponse), pas sur Sequelize
 * ni sur Resend — aucun des deux n'est joignable en CI.
 */

// `otplib` (et sa dépendance `@scure/base`) sont publiés en ESM pur, que la
// configuration Jest du projet ne transforme pas. Charger `app.js` en entier
// les tire via auth.route → mfa.service, et le test échouerait sur un
// `SyntaxError: Unexpected token 'export'` sans rapport avec ce qu'il vérifie.
// Neutralisé ICI plutôt que dans la config partagée : aucun autre test ne
// charge l'application complète aujourd'hui.
// Limiteurs neutralisés : toutes les requêtes d'un test partent de la même IP,
// et `authRateLimit` (volontairement le seuil le plus strict du projet) répond
// 429 dès la 6e — les cas de validation ci-dessous n'atteindraient jamais Joi.
// Le limiteur EST bien actif sur la route en production ; son fonctionnement
// est couvert par `rateLimit.sharedStore.test.js`.
jest.mock('../middlewares/rateLimit.middleware.js', () => {
  const passe = (req, res, next) => next();
  return {
    authRateLimit: passe,
    mutationRateLimit: passe,
    adminRateLimit: passe,
    otpEmailRateLimit: passe,
    authenticatedRateLimit: passe,
  };
});

jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

jest.mock('../models/index.js', () => ({
  DemandeSuppression: {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(async (donnees) => ({
      ...donnees,
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-08-23T10:00:00Z'),
    })),
    findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    findByPk: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendDemandeSuppressionEmail: jest.fn().mockResolvedValue({ id: 'email_test' }),
}));

const request = require('supertest');
const app = require('../app.js');
const { DemandeSuppression } = require('../models/index.js');
const { sendDemandeSuppressionEmail } = require('../infrastructure/emailService.js');

const CHEMIN = '/api/v1/suppression-compte';

describe(`POST ${CHEMIN} — dépôt public`, () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DemandeSuppression.findOne.mockResolvedValue(null);
  });

  it("est joignable SANS authentification — c'est l'exigence Google Play", async () => {
    const res = await request(app)
      .post(CHEMIN)
      .send({ email: 'utilisateur@exemple.com', objet: 'Je souhaite supprimer mon compte et mes données.' });

    // Surtout pas 401/403 : un utilisateur ayant désinstallé l'app n'a plus
    // de jeton, et doit malgré tout pouvoir déposer sa demande.
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('enregistre la demande en normalisant l\'adresse', async () => {
    await request(app)
      .post(CHEMIN)
      .send({ email: '  Utilisateur@Exemple.COM ', objet: 'Suppression de mon compte demandée.' });

    expect(DemandeSuppression.create).toHaveBeenCalledTimes(1);
    const donnees = DemandeSuppression.create.mock.calls[0][0];
    // Sans normalisation, deux demandes de la même personne seraient traitées
    // comme deux dossiers distincts selon la casse saisie.
    expect(donnees.email).toBe('utilisateur@exemple.com');
    expect(donnees.statut).toBe('en_attente');
  });

  it("notifie l'équipe par email", async () => {
    await request(app)
      .post(CHEMIN)
      .send({ email: 'utilisateur@exemple.com', objet: 'Merci de supprimer mon compte.' });

    expect(sendDemandeSuppressionEmail).toHaveBeenCalledTimes(1);
  });

  it("répond quand même 201 si l'envoi d'email échoue", async () => {
    sendDemandeSuppressionEmail.mockRejectedValueOnce(new Error('Resend indisponible'));

    const res = await request(app)
      .post(CHEMIN)
      .send({ email: 'utilisateur@exemple.com', objet: 'Merci de supprimer mon compte.' });

    // La demande est déjà en base : faire échouer le dépôt côté visiteur
    // l'inciterait à recommencer, alors que sa demande est bien enregistrée.
    expect(res.status).toBe(201);
    expect(DemandeSuppression.create).toHaveBeenCalledTimes(1);
  });

  it('ne crée pas de doublon quand une demande est déjà en attente', async () => {
    DemandeSuppression.findOne.mockResolvedValueOnce({
      id: 'existante', email: 'utilisateur@exemple.com', statut: 'en_attente',
    });

    const res = await request(app)
      .post(CHEMIN)
      .send({ email: 'utilisateur@exemple.com', objet: 'Je redépose ma demande.' });

    expect(res.status).toBe(201);
    expect(DemandeSuppression.create).not.toHaveBeenCalled();
  });

  describe('validation des entrées — la route est ouverte à Internet', () => {
    it('refuse une adresse invalide', async () => {
      const res = await request(app)
        .post(CHEMIN)
        .send({ email: 'pas-une-adresse', objet: 'Suppression de mon compte demandée.' });
      expect(res.status).toBe(422);
    });

    it('refuse un objet trop court', async () => {
      const res = await request(app)
        .post(CHEMIN)
        .send({ email: 'utilisateur@exemple.com', objet: 'court' });
      expect(res.status).toBe(422);
    });

    it('refuse un objet démesuré — sinon la table grossit sans limite', async () => {
      const res = await request(app)
        .post(CHEMIN)
        .send({ email: 'utilisateur@exemple.com', objet: 'x'.repeat(2001) });
      expect(res.status).toBe(422);
    });

    it('refuse une requête sans corps', async () => {
      const res = await request(app).post(CHEMIN).send({});
      expect(res.status).toBe(422);
    });
  });
});

describe('GET /api/v1/admin/demandes-suppression — liste admin', () => {
  it('refuse un accès non authentifié', async () => {
    const res = await request(app).get('/api/v1/admin/demandes-suppression');
    // La liste expose les adresses de tous les demandeurs : elle ne doit
    // jamais répondre sans jeton.
    expect([401, 403]).toContain(res.status);
  });
});
