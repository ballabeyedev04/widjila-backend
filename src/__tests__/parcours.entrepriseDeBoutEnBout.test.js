'use strict';

/**
 * Tests — le parcours complet d'une entreprise, maillon par maillon.
 *
 * Inscription → validation → essai → demande de chantier → plans → validation
 * → réserves. Chaque maillon a déjà ses tests ; ce fichier vérifie les
 * JOINTURES, là où deux règles écrites séparément finissent par se contredire.
 *
 * Deux défauts trouvés en le construisant, tous deux sur le chemin le plus
 * emprunté :
 *
 *   1. une réserve pouvait naître sur un chantier ENCORE EN ATTENTE. La garde
 *      existait au niveau du plan, mais une réserve sans plan est permise — un
 *      chantier dont les plans ne sont pas encore déposés ne doit pas empêcher
 *      un relevé. Refusée ensuite, la demande laissait des réserves rattachées
 *      à un chantier que personne ne validerait jamais.
 *
 *   2. un bâtiment nommé « A » était refusé d'un 422. Le schéma exigeait deux
 *      caractères, alors que les bâtiments d'un chantier s'appellent « A »,
 *      « B », « C » — et que le bâtiment est la première chose à créer sur
 *      l'écran de dépôt.
 */

const {
  creerBatimentSchema,
  modifierBatimentSchema,
  creerEtageSchema,
  creerChantierSchema,
} = require('../modules/chantier/validation/chantier.validation.js');

const ReserveService = require('../modules/reserve/service/reserve.service.js');
const { STATUT_CHANTIER_EN_DEMANDE } = require('../config/enums.js');
const {
  OPERATIONNEL, RESERVE_INTERVENANTS, DEPOSANT, PILOTAGE, FACTURATION,
} = require('../config/roles.js');

describe('les noms de la structure', () => {
  it.each(['A', 'B', 'C'])('accepte un bâtiment nommé « %s »', (nom) => {
    // C'est ainsi que le client décrit son chantier : « on voit les bâtiments
    // A, B, C ». Un plancher à deux caractères refusait exactement ces
    // noms-là.
    expect(creerBatimentSchema.validate({ nom }).error).toBeUndefined();
  });

  it('accepte aussi de les renommer', () => {
    // Sans quoi un bâtiment « A » se créerait mais ne se renommerait plus.
    expect(modifierBatimentSchema.validate({ nom: 'A' }).error).toBeUndefined();
  });

  it('refuse toujours un nom vide', () => {
    expect(creerBatimentSchema.validate({ nom: '' }).error).toBeDefined();
    expect(creerBatimentSchema.validate({ nom: '   ' }).error).toBeDefined();
  });

  it.each(['SS1', 'RDC', 'R+2', 'R+12'])('accepte le code de niveau « %s »', (code) => {
    // Les codes du référentiel, tels que l'entreprise les choisit ou les crée.
    const { error } = creerEtageSchema.validate({
      nom: code, typeNiveau: 'etage', codeNiveau: code,
    });

    expect(error).toBeUndefined();
  });

  it('accepte les trois natures de niveau', () => {
    for (const type of ['sous_sol', 'etage', 'toiture']) {
      expect(creerEtageSchema.validate({ nom: 'X', typeNiveau: type }).error).toBeUndefined();
    }
  });
});

describe('la demande de chantier', () => {
  it('accepte les champs que le mobile envoie, et rien de plus', () => {
    // Le formulaire de demande du mobile, champ pour champ. Un seul refus ici
    // et l'entreprise perd toute sa saisie sur un 422.
    const { error } = creerChantierSchema.validate({
      nom: 'Résidence Horizon',
      code: 'CH-A1B2',
      description: 'Trois bâtiments, deux sous-sols',
      adresse: 'Route de Ngor, Dakar',
      latitude: 14.7,
      longitude: -17.5,
      date_debut: '2026-09-10',
      date_fin: '2027-06-30',
      budget: 250000000,
    });

    expect(error).toBeUndefined();
  });

  it('accepte une demande réduite au seul nom', () => {
    // « Une entreprise qui dépose ses plans un vendredi soir n'a pas forcément
    // le budget sous la main. »
    expect(creerChantierSchema.validate({ nom: 'Résidence Horizon' }).error).toBeUndefined();
  });
});

describe('les réserves n’arrivent qu’après la validation', () => {
  it.each(STATUT_CHANTIER_EN_DEMANDE)('refuse une réserve sur un chantier « %s »', (statut) => {
    const refus = ReserveService._refusSurDemande({ statut });

    expect(refus).toEqual(expect.any(String));
  });

  it('dit POURQUOI, et ce n’est pas le même motif', () => {
    // « En attente » se corrige en patientant ; « refusée » demande de reprendre
    // la demande. Un message unique laisserait l'utilisateur attendre en vain.
    expect(ReserveService._refusSurDemande({ statut: 'en_attente_validation' }))
      .toEqual(expect.stringContaining('attend une validation'));
    expect(ReserveService._refusSurDemande({ statut: 'rejete' }))
      .toEqual(expect.stringContaining('refusée'));
  });

  it.each(['en_preparation', 'en_cours', 'en_pause'])(
    'laisse poser une réserve sur un chantier « %s »',
    (statut) => {
      // Une fois validé, le chantier accueille les réserves : c'est l'étape
      // suivante du parcours.
      expect(ReserveService._refusSurDemande({ statut })).toBeNull();
    }
  );
});

describe('le titulaire tient tout son parcours', () => {
  // Le fil complet, en une lecture : chaque geste de la chaîne décrite par le
  // client doit lui être ouvert.
  const etapes = {
    'déposer une demande de chantier': DEPOSANT,
    'créer ses bâtiments et ses niveaux': OPERATIONNEL,
    'poser des réserves une fois validé': RESERVE_INTERVENANTS,
    'générer ses rapports': PILOTAGE,
    'payer son abonnement': FACTURATION,
  };

  it.each(Object.keys(etapes))('peut %s', (etape) => {
    expect(etapes[etape]).toContain('Entreprise');
  });
});
