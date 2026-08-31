'use strict';

/**
 * Tests — circuit de validation des chantiers.
 *
 * Règle donnée par le client : « n'importe qui qui crée le chantier sauf Admin
 * reste en attente ». Deux choses doivent tenir, et ce sont exactement les
 * deux qu'un contournement viserait :
 *
 *   1. le statut ne se déduit QUE du rôle de l'appelant, jamais du corps de la
 *      requête — sinon `statut: 'en_cours'` suffirait à sauter la validation ;
 *   2. le refus doit porter un motif, et la correction doit ramener la demande
 *      dans la file, sans effacer la structure déjà saisie.
 *
 * S'y ajoute la garde du parcours « Envoi Plan » : la route de dépôt a été
 * élargie à `Entreprise`, ce qui serait trop large sans elle.
 */

const ChantierService = require('../modules/chantier/service/chantier.service.js');
const { STATUT_CHANTIER, STATUT_CHANTIER_EN_DEMANDE } = require('../config/enums.js');
const { DEPOSANT, GESTION } = require('../config/roles.js');

describe('_naitEnAttente — qui passe par la validation', () => {
  it.each(['ChefProjet', 'ConducteurTravaux', 'MaitreOeuvre', 'Entreprise', 'BureauControle', 'MaitreOuvrage'])(
    'met en attente un chantier créé par %s',
    (role) => {
      expect(ChantierService._naitEnAttente({ id: 'u1', role })).toBe(true);
    }
  );

  it('laisse le super-admin plateforme créer directement', () => {
    // C'est la seule exception énoncée par le client. Elle est indispensable :
    // sans elle, personne ne pourrait valider la toute première demande.
    expect(ChantierService._naitEnAttente({ id: 'u1', role: 'Admin' })).toBe(false);
  });

  it('crée directement quand aucun auteur n’est identifié', () => {
    // Amorçage, duplication interne, tests : il n'y aurait ni demandeur à qui
    // attribuer la demande, ni personne pour la trancher.
    expect(ChantierService._naitEnAttente(null)).toBe(false);
    expect(ChantierService._naitEnAttente({})).toBe(false);
    expect(ChantierService._naitEnAttente({ role: 'Entreprise' })).toBe(false);
  });
});

describe('cohérence des statuts', () => {
  it('déclare les deux statuts de demande', () => {
    expect(STATUT_CHANTIER).toEqual(expect.arrayContaining(['en_attente_validation', 'rejete']));
  });

  it('n’range en demande que des statuts réellement déclarés', () => {
    // Une faute de frappe ici filtrerait sur un statut inexistant : la liste
    // des chantiers deviendrait vide sans qu'aucune erreur ne soit levée.
    for (const statut of STATUT_CHANTIER_EN_DEMANDE) {
      expect(STATUT_CHANTIER).toContain(statut);
    }
  });

  it('conserve les cinq statuts historiques', () => {
    // Non-régression : un chantier existant porte l'un d'eux, et le retirer
    // ferait échouer sa prochaine écriture sur la validation du modèle.
    for (const statut of ['en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture']) {
      expect(STATUT_CHANTIER).toContain(statut);
    }
  });
});

describe('groupes de rôles', () => {
  it('ouvre le dépôt à l’entreprise', () => {
    // C'est le blocage d'origine : l'entreprise recevait un 403 avant même
    // d'atteindre le circuit de validation.
    expect(DEPOSANT).toContain('Entreprise');
  });

  it('n’ouvre pas le dépôt au sous-traitant ni au client', () => {
    expect(DEPOSANT).not.toContain('SousTraitant');
    expect(DEPOSANT).not.toContain('Client');
  });

  it('réserve le verdict à la gestion, entreprise exclue', () => {
    // Sans quoi une entreprise validerait sa propre demande, et le circuit ne
    // servirait à rien.
    expect(GESTION).not.toContain('Entreprise');
  });
});

describe('changerStatut — le circuit n’est pas une liste déroulante', () => {
  // Les deux statuts de demande sont servis par `/referentiels/enums`, donc
  // proposés par la liste « changer le statut ». Sans garde, un chef de projet
  // remettrait un chantier en activité « en attente » d'un clic — sans
  // demandeur, sans motif, sans courriel, et hors de toutes les listes.
  //
  // Le service interroge la base : on remplace `Chantier.findOne` le temps du
  // test, sans connexion réelle.
  const { Chantier } = require('../models/index.js');

  let findOne;
  beforeEach(() => {
    findOne = jest.spyOn(Chantier, 'findOne');
  });
  afterEach(() => {
    findOne.mockRestore();
  });

  it.each(['en_attente_validation', 'rejete'])('refuse de basculer vers « %s »', async (statut) => {
    findOne.mockResolvedValue({ id: 'c1', statut: 'en_cours' });

    const r = await ChantierService.changerStatut('org1', 'c1', statut);

    expect(r.success).toBe(false);
    expect(r.message).toEqual(expect.stringContaining('circuit de validation'));
  });

  it('refuse de faire sortir une demande par la liste déroulante', async () => {
    // Une demande ne devient pas un chantier actif ainsi : elle se VALIDE,
    // c'est ce qui prévient le demandeur.
    findOne.mockResolvedValue({ id: 'c1', statut: 'en_attente_validation' });

    const r = await ChantierService.changerStatut('org1', 'c1', 'en_cours');

    expect(r.success).toBe(false);
    expect(r.message).toEqual(expect.stringContaining('demande en cours'));
  });
});

describe('_refusDepot — garde du parcours « Envoi Plan »', () => {
  const PlanService = require('../modules/plan/service/plan.service.js');

  const demandeDe = (demandeurId) => ({ statut: 'en_attente_validation', demandeurId });

  it('laisse l’entreprise déposer sur SA demande en attente', () => {
    // C'est précisément ce que le parcours doit permettre.
    expect(PlanService._refusDepot(demandeDe('u1'), { id: 'u1', role: 'Entreprise' })).toBeNull();
  });

  it('refuse le dépôt sur la demande de quelqu’un d’autre', () => {
    // La route laisse passer `DEPOSANT` ; sans cette garde, une entreprise
    // joindrait ses plans à la demande d'un concurrent de la même organisation.
    expect(PlanService._refusDepot(demandeDe('u1'), { id: 'u2', role: 'Entreprise' })).toEqual(
      expect.stringContaining('vos propres demandes')
    );
  });

  it.each(['en_preparation', 'en_cours', 'en_pause', 'archive', 'cloture'])(
    'refuse le dépôt de l’entreprise sur un chantier « %s »',
    (statut) => {
      // Le point le plus sensible de l'élargissement : une fois le chantier
      // validé, l'entreprise NE doit pas pouvoir y déposer de plans — c'était
      // déjà interdit avant, et ça doit le rester.
      expect(PlanService._refusDepot({ statut, demandeurId: 'u1' }, { id: 'u1', role: 'Entreprise' }))
        .toEqual(expect.stringContaining('en attente de validation'));
    }
  );

  it('refuse le dépôt sur une demande déjà refusée', () => {
    // Une demande « rejete » attend une correction, pas des pièces jointes.
    expect(PlanService._refusDepot({ statut: 'rejete', demandeurId: 'u1' }, { id: 'u1', role: 'Entreprise' }))
      .not.toBeNull();
  });

  it.each(['ChefProjet', 'ConducteurTravaux', 'MaitreOeuvre', 'BureauControle', 'Admin'])(
    'ne restreint pas %s (non-régression)',
    (role) => {
      // Ces rôles déposaient déjà des plans sur n'importe quel chantier de
      // leur organisation. La garde ne doit rien leur retirer.
      expect(PlanService._refusDepot({ statut: 'en_cours' }, { id: 'u9', role })).toBeNull();
    }
  );

  it('ne s’applique pas aux appels internes sans auteur', () => {
    // Duplication de chantier, amorçage : aucune requête, donc aucun rôle.
    expect(PlanService._refusDepot({ statut: 'en_cours' }, null)).toBeNull();
    expect(PlanService._refusDepot({ statut: 'en_cours' }, {})).toBeNull();
  });
});
