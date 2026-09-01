'use strict';

/**
 * Tests — parcours « Envoi de plans » et cloisonnement.
 *
 * Ce que ces tests protègent, dans l'ordre où ça casserait :
 *
 *   1. le CLOISONNEMENT — un chantier issu d'une demande n'appartient qu'à son
 *      demandeur. La liste et le détail doivent dire la même chose, sinon un
 *      chantier introuvable dans la liste s'ouvrirait par son URL ;
 *   2. la portée ÉTROITE de ce cloisonnement — les chantiers existants, tous
 *      créés hors circuit, ne doivent rien perdre de leur visibilité ;
 *   3. les ÉNUMÉRATIONS qui portent les trois sections de l'écran de dépôt.
 */

const ChantierService = require('../modules/chantier/service/chantier.service.js');
const { STATUT_PLAN, TYPE_NIVEAU, VUE_PUBLIQUE } = require('../config/enums.js');

const DEMANDE = { demandeurId: 'u1' };
const CHANTIER_ORDINAIRE = { demandeurId: null };

describe('_peutVoir — cloisonnement des chantiers issus du circuit', () => {
  it('laisse le demandeur voir sa demande', () => {
    expect(ChantierService._peutVoir(DEMANDE, { id: 'u1', role: 'Entreprise' })).toBe(true);
  });

  it('cache la demande d’un autre', () => {
    // C'est le cœur de la règle : « utilisables pour cette entreprise
    // uniquement ». Sans elle, une entreprise verrait les chantiers de ses
    // concurrents dans la même organisation.
    expect(ChantierService._peutVoir(DEMANDE, { id: 'u2', role: 'Entreprise' })).toBe(false);
  });

  it.each(['ChefProjet', 'MaitreOuvrage', 'Admin'])(
    'laisse %s voir une demande qui n’est pas la sienne',
    (role) => {
      // Ceux qui tranchent la demande doivent la lire, puis superviser le
      // chantier qu'ils ont validé.
      expect(ChantierService._peutVoir(DEMANDE, { id: 'u9', role })).toBe(true);
    }
  );

  it.each(['Entreprise', 'ConducteurTravaux', 'BureauControle', 'Client', 'SousTraitant'])(
    'ne retire rien à %s sur un chantier hors circuit',
    (role) => {
      // NON-RÉGRESSION, le point le plus important de cette série : tous les
      // chantiers existants ont `demandeurId = null`. Si cette assertion
      // tombe, des équipes perdent l'accès à leurs chantiers du jour au
      // lendemain.
      expect(ChantierService._peutVoir(CHANTIER_ORDINAIRE, { id: 'u2', role })).toBe(true);
    }
  );

  it('ne filtre rien quand aucun auteur n’est identifié', () => {
    // Appels internes (tâches, scripts) : il n'y a personne à cloisonner.
    expect(ChantierService._peutVoir(DEMANDE, null)).toBe(true);
    expect(ChantierService._peutVoir(DEMANDE, {})).toBe(true);
  });
});

describe('énumérations du parcours', () => {
  it('déclare les trois sections de l’écran de dépôt', () => {
    // SOUS-SOLS · ÉTAGES · TOITURE — ce sont elles que le mobile affiche.
    expect(TYPE_NIVEAU).toEqual(['sous_sol', 'etage', 'toiture']);
  });

  it('déclare le statut d’attente d’un plan', () => {
    // Sans lui, un plan joint à une demande serait indiscernable d'un plan
    // validé.
    expect(STATUT_PLAN).toContain('en_attente_validation');
    expect(STATUT_PLAN).toContain('actif');
  });

  it('sert les deux listes aux clients', () => {
    // Le mobile construit ses sections d'après `/referentiels/enums` : une
    // liste absente de la vue publique laisserait l'écran vide.
    expect(VUE_PUBLIQUE.typesNiveau).toEqual(TYPE_NIVEAU);
    expect(VUE_PUBLIQUE.statutsPlan).toEqual(STATUT_PLAN);
  });
});

describe('référentiel des codes de niveau', () => {
  const CodeNiveauService = require('../modules/referentiel/service/codeNiveau.service.js');

  it('refuse un type de niveau inconnu', () => {
    return expect(
      CodeNiveauService.creer('org1', { typeNiveau: 'sous_marin', code: 'SM1' })
    ).resolves.toEqual(expect.objectContaining({ success: false }));
  });

  it('refuse une création hors organisation', async () => {
    // Le super-admin plateforme n'appartient à aucune organisation : le
    // laisser créer ici écrirait dans le catalogue standard sans le dire.
    const r = await CodeNiveauService.creer(null, { typeNiveau: 'etage', code: 'R+1' });

    expect(r.success).toBe(false);
    expect(r.message).toEqual(expect.stringContaining('organisation'));
  });

  it('refuse un code vide', async () => {
    const r = await CodeNiveauService.creer('org1', { typeNiveau: 'etage', code: '   ' });
    expect(r.success).toBe(false);
  });

  it('restreint la visibilité au standard hors organisation', () => {
    // Un compte sans organisation ne doit voir que le catalogue de la
    // plateforme, jamais les codes inventés par un client.
    expect(CodeNiveauService._visibilite(null)).toEqual({ organisationId: null });
  });

  it('ouvre la visibilité au standard ET à l’organisation', () => {
    const filtre = CodeNiveauService._visibilite('org1');
    const branches = Object.getOwnPropertySymbols(filtre)
      .flatMap((s) => filtre[s]);

    expect(branches).toEqual(
      expect.arrayContaining([{ organisationId: null }, { organisationId: 'org1' }])
    );
  });
});
