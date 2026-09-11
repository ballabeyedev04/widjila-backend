'use strict';

/**
 * Tests — le référentiel du module Rapports.
 *
 * Le cahier des charges parle cinq statuts et trois gravités ; la base en
 * connaît onze et quatre. Ce fichier verrouille la TRADUCTION entre les deux,
 * parce que c'est elle qui décide si une réserve apparaît dans un rapport :
 * un statut oublié ici sortirait des filtres et des comptages sans que rien
 * ne le signale.
 */

const { STATUT_RESERVE, SEVERITE_PRIORITE } = require('../config/enums.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');

describe('§ 4 — les cinq statuts du rapport', () => {
  it('sont exactement ceux du cahier des charges, dans son ordre', () => {
    expect(R.CODES_STATUT_RAPPORT).toEqual(['A_TRAITER', 'EN_COURS', 'A_CONTROLER', 'LEVEE', 'CLOTUREE']);
    expect(R.CODES_STATUT_RAPPORT.map(R.libelleStatutRapport))
      .toEqual(['À traiter', 'En cours', 'À contrôler', 'Levée', 'Clôturée']);
  });

  it('chaque statut de réserve appartient à UN et UN SEUL statut de rapport', () => {
    for (const statut of STATUT_RESERVE) {
      const porteurs = R.CODES_STATUT_RAPPORT.filter((c) => R.STATUTS_RAPPORT[c].statuts.includes(statut));
      expect({ statut, porteurs: porteurs.length }).toEqual({ statut, porteurs: 1 });
    }
  });

  it('traduit une sélection vers les statuts réels', () => {
    expect(R.statutsReservePour(['A_CONTROLER'])).toEqual(['corrigee', 'a_verifier']);
    expect(R.statutsReservePour(['LEVEE', 'CLOTUREE'])).toEqual(['validee', 'cloturee']);
    // Une valeur inconnue n'élargit rien.
    expect(R.statutsReservePour(['INCONNU'])).toEqual([]);
  });

  it('range une réserve refusée ou en retard parmi celles « à traiter »', () => {
    // Dans les deux cas, la correction est à (re)faire et personne n'y
    // travaille : les classer « en cours » mentirait sur l'avancement.
    expect(R.statutRapportDe('refusee')).toBe('A_TRAITER');
    expect(R.statutRapportDe('en_retard')).toBe('A_TRAITER');
    expect(R.statutRapportDe('a_verifier')).toBe('A_CONTROLER');
  });
});

describe('§ 4 — les trois gravités', () => {
  it('sont Critique, Majeure, Mineure', () => {
    expect(R.CODES_GRAVITE).toEqual(['CRITIQUE', 'MAJEURE', 'MINEURE']);
  });

  it('chaque sévérité de la base appartient à une gravité', () => {
    for (const severite of SEVERITE_PRIORITE) expect(R.graviteDe(severite)).not.toBeNull();
  });

  it('« haute » devient Majeure — la valeur de l’exemple du § 8', () => {
    expect(R.graviteDe('haute')).toBe('MAJEURE');
    expect(R.severitesPour(['MINEURE'])).toEqual(['moyenne', 'faible']);
  });

  it('une sévérité absente n’est rangée NULLE PART — pas d’office en mineure', () => {
    expect(R.graviteDe(null)).toBeNull();
    expect(R.graviteDe(undefined)).toBeNull();
  });
});

describe('§ 5 — les modèles', () => {
  it('propose les huit modèles de la version actuelle', () => {
    expect(R.CODES_MODELE).toEqual([
      'GLOBAL', 'BATIMENT', 'ETAGE_ZONE', 'ENTREPRISE', 'CORPS_ETAT', 'A_TRAITER', 'LEVEES', 'OPR',
    ]);
  });

  it('annonce le SAV comme prévu plus tard, pas comme inconnu', () => {
    expect(R.modele('SAV')).toBeNull();
    expect(R.MODELES_VERSION_ULTERIEURE.SAV).toBeDefined();
  });

  it('les modèles ciblés EXIGENT leur filtre', () => {
    expect(R.MODELES.BATIMENT.filtresRequis).toEqual(['batiment']);
    expect(R.MODELES.ENTREPRISE.filtresRequis).toEqual(['entreprise']);
    expect(R.MODELES.CORPS_ETAT.filtresRequis).toEqual(['corps_etat']);
    expect(R.MODELES.ETAGE_ZONE.filtresRequis).toEqual(['etage_ou_zone']);
  });

  it('« réserves levées » utilise la fiche de levée du § 17', () => {
    expect(R.MODELES.LEVEES.fiche).toBe('levee');
    expect(R.MODELES.LEVEES.filtresParDefaut.statuts).toEqual(['LEVEE', 'CLOTUREE']);
  });

  it('accepte le modèle quelle que soit la casse', () => {
    expect(R.modele('global')).toBe(R.MODELES.GLOBAL);
  });
});

describe('§ 10 et § 19 — sections et états', () => {
  it('les sections sont exactement celles du § 10', () => {
    expect(R.SECTIONS).toEqual(['summary', 'plans', 'photos', 'location', 'history']);
  });

  it('les sept états du § 19 existent', () => {
    expect(R.CODES_ETAT).toEqual([
      'brouillon', 'en_attente', 'generation', 'genere', 'envoye', 'echec', 'archive',
    ]);
  });

  it('les formats sont PDF et XLSX', () => {
    expect(R.FORMATS).toEqual(['PDF', 'XLSX']);
  });
});

describe('compatibilité avec l’existant', () => {
  it('chaque ancien type de rapport a un modèle', () => {
    for (const type of ['reserves', 'entreprise', 'batiment', 'qualite', 'visite', 'opr']) {
      expect(R.MODELES[R.TYPE_LEGACY_VERS_MODELE[type]]).toBeDefined();
    }
  });

  it('le garde-fou de couverture ne lève pas sur l’ENUM actuel', () => {
    expect(() => R.verifierCouverture()).not.toThrow();
  });
});
