'use strict';

/**
 * Tests — l'OFFRE GRATUITE, le socle qui remplace le mur de fin d'essai.
 *
 * ## Ce qui a changé, et pourquoi
 *
 * Au bout des deux jours d'essai, une organisation perdait TOUT : plus un
 * chantier, plus une réserve. Deux jours ne suffisent pas à juger d'un outil
 * de chantier — et l'App Store a refusé l'application (directive 3.1.1, le
 * 23/09/2026) parce qu'un contenu payant y était accessible sans achat
 * intégré, l'inscription menant à un paiement fait ailleurs.
 *
 * Désormais, l'essai terminé laisse place à un socle permanent : un chantier,
 * deux utilisateurs, toutes les fonctionnalités. L'application reste
 * utilisable sans rien payer ; les formules payantes ne lèvent QUE des
 * plafonds de volume.
 *
 * ## Ce que ces tests verrouillent
 *
 *   1. l'ordre de priorité : souscription payante > essai > offre gratuite ;
 *   2. l'offre gratuite ouvre toutes les fonctionnalités, borne les volumes ;
 *   3. elle ne se périme pas (ni échéance, ni compte à rebours) ;
 *   4. le refus de plafond ne renvoie plus vers une formule — ce message
 *      traverse l'application iOS, où toute incitation à souscrire hors achat
 *      intégré est interdite ;
 *   5. un compte SANS organisation (super-admin) n'y a pas droit : il n'y a
 *      rien à quoi rattacher des droits.
 */

jest.mock('../models/index.js', () => ({
  Organisation: { findByPk: jest.fn() },
  PlanAbonnement: { findOne: jest.fn(), findAll: jest.fn() },
  AbonnementSouscrit: { findOne: jest.fn() },
  Utilisateur: { count: jest.fn() },
  Chantier: { count: jest.fn() },
}));

const {
  Organisation, AbonnementSouscrit, Utilisateur, Chantier,
} = require('../models/index.js');
const DroitsService = require('../modules/subscription/service/droits.service.js');
const {
  CODE_GRATUIT, NOM_GRATUIT, LIMITE_CHANTIERS, LIMITE_UTILISATEURS,
} = require('../config/offreGratuite.js');

const ORG = 'org-1';

/** Organisation dont l'essai s'est achevé hier. */
const orgEssaiFini = () => ({
  id: ORG,
  trial_ends_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
  is_subscribed: false,
});

const orgEssaiEnCours = () => ({
  id: ORG,
  trial_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
  is_subscribed: false,
});

const souscriptionPro = () => ({
  id: 's1', organisationId: ORG, statut: 'active',
  plan_code: 'pro', plan_nom: 'Pro', date_fin: new Date(Date.now() + 30 * 86400000),
  plan: {
    code: 'pro', nom: 'Pro', fonctionnalites: ['reserves', 'rapports'],
    limite_utilisateurs: 5, limite_chantiers: null,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  AbonnementSouscrit.findOne.mockResolvedValue(null);
  Utilisateur.count.mockResolvedValue(0);
  Chantier.count.mockResolvedValue(0);
});

describe('le socle gratuit', () => {
  it('prend le relais quand l’essai est fini et qu’aucune formule n’est souscrite', async () => {
    Organisation.findByPk.mockResolvedValue(orgEssaiFini());

    const droits = await DroitsService.getDroits(ORG);

    expect(droits).toMatchObject({
      actif: true,
      source: 'gratuit',
      planCode: CODE_GRATUIT,
      planNom: NOM_GRATUIT,
      fonctionnalites: null,
      limiteChantiers: LIMITE_CHANTIERS,
      limiteUtilisateurs: LIMITE_UTILISATEURS,
      essaiEnCours: false,
      dateFin: null,
      joursRestants: null,
    });
  });

  it('ne se périme jamais : aucune échéance, aucun compte à rebours', async () => {
    Organisation.findByPk.mockResolvedValue(orgEssaiFini());

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.dateFin).toBeNull();
    expect(droits.joursRestants).toBeNull();
  });
});

describe('l’ordre de priorité', () => {
  it('une formule PAYANTE l’emporte sur le socle', async () => {
    Organisation.findByPk.mockResolvedValue(orgEssaiFini());
    AbonnementSouscrit.findOne.mockResolvedValue(souscriptionPro());

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('abonnement');
    expect(droits.planCode).toBe('pro');
    expect(droits.limiteUtilisateurs).toBe(5);
  });

  it('un essai EN COURS l’emporte aussi — il est sans limite de volume', async () => {
    Organisation.findByPk.mockResolvedValue(orgEssaiEnCours());

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.source).toBe('essai');
    expect(droits.essaiEnCours).toBe(true);
    expect(droits.limiteChantiers).toBeNull();
  });

  it('un compte SANS organisation n’a toujours aucun droit', async () => {
    // Le super-admin plateforme : rien à quoi rattacher une offre.
    const droits = await DroitsService.getDroits(null);

    expect(droits.actif).toBe(false);
    expect(droits.source).toBe('aucun');
  });

  it('une organisation introuvable n’a aucun droit non plus', async () => {
    Organisation.findByPk.mockResolvedValue(null);

    const droits = await DroitsService.getDroits(ORG);

    expect(droits.actif).toBe(false);
    expect(droits.source).toBe('aucun');
  });
});

describe('ce que le socle permet et ce qu’il borne', () => {
  beforeEach(() => Organisation.findByPk.mockResolvedValue(orgEssaiFini()));

  it.each(['reserves', 'mobile', 'stockage', 'rapports', 'annotations', 'api'])(
    'ouvre « %s » : seuls les volumes distinguent les formules',
    async (fonctionnalite) => {
      const res = await DroitsService.peutUtiliser(ORG, fonctionnalite);
      expect(res.autorise).toBe(true);
    }
  );

  it('accepte le premier chantier et le deuxième utilisateur', async () => {
    Chantier.count.mockResolvedValue(0);
    Utilisateur.count.mockResolvedValue(1);

    expect((await DroitsService.verifierLimite(ORG, 'chantiers')).autorise).toBe(true);
    expect((await DroitsService.verifierLimite(ORG, 'utilisateurs')).autorise).toBe(true);
  });

  it('refuse le deuxième chantier et le troisième utilisateur', async () => {
    Chantier.count.mockResolvedValue(LIMITE_CHANTIERS);
    Utilisateur.count.mockResolvedValue(LIMITE_UTILISATEURS);

    const chantiers = await DroitsService.verifierLimite(ORG, 'chantiers');
    const utilisateurs = await DroitsService.verifierLimite(ORG, 'utilisateurs');

    expect(chantiers.autorise).toBe(false);
    expect(chantiers.raison).toBe('SUBSCRIPTION_LIMIT_REACHED');
    expect(utilisateurs.autorise).toBe(false);
    expect(utilisateurs.raison).toBe('SUBSCRIPTION_LIMIT_REACHED');
  });

  it('affiche l’usage face aux plafonds du socle', async () => {
    Utilisateur.count.mockResolvedValue(2);
    Chantier.count.mockResolvedValue(1);

    const usage = await DroitsService.getUsage(ORG);

    expect(usage.utilisateurs).toEqual({ courant: 2, limite: LIMITE_UTILISATEURS });
    expect(usage.chantiers).toEqual({ courant: 1, limite: LIMITE_CHANTIERS });
  });
});

describe('le message de refus', () => {
  const { ForbiddenError } = require('../errors/AppError.js');
  const requireFonctionnalite = require('../middlewares/requireFonctionnalite.middleware.js');

  /** Joue le middleware de limite et rend l'erreur passée à `next`. */
  async function refus(droitsSource) {
    Organisation.findByPk.mockResolvedValue(
      droitsSource === 'gratuit' ? orgEssaiFini() : orgEssaiFini()
    );
    if (droitsSource === 'abonnement') {
      AbonnementSouscrit.findOne.mockResolvedValue({
        ...souscriptionPro(),
        plan: { ...souscriptionPro().plan, limite_chantiers: 3 },
      });
      Chantier.count.mockResolvedValue(3);
    } else {
      Chantier.count.mockResolvedValue(LIMITE_CHANTIERS);
    }

    const middleware = requireFonctionnalite.verifierLimite('chantiers');
    let erreur;
    await middleware(
      { user: { organisationId: ORG } },
      {},
      (e) => { erreur = e; }
    );
    return erreur;
  }

  it('sur l’offre gratuite : annonce la limite SANS dire où payer', async () => {
    // Ce message traverse l'application iOS. Toute incitation à souscrire
    // hors achat intégré y est interdite (directive 3.1.1).
    const erreur = await refus('gratuit');

    expect(erreur).toBeInstanceOf(ForbiddenError);
    expect(erreur.message).toMatch(/offre gratuite est limitée à 1 chantiers/i);
    expect(erreur.message).not.toMatch(/formule supérieure|souscriv|abonnement/i);
  });

  it('sur une formule payante : invite toujours à passer au-dessus', async () => {
    const erreur = await refus('abonnement');

    expect(erreur.message).toMatch(/formule supérieure/i);
  });
});
