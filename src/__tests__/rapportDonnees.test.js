'use strict';

/**
 * Tests — les données d'un rapport : filtres (§ 4), localisation (§ 7),
 * levée (§ 17) et les tests d'acceptation du § 23 qui portent sur le
 * PÉRIMÈTRE :
 *
 *   - Rapport global : toutes les réserves attendues.
 *   - Filtre entreprise : aucune réserve d'une autre entreprise.
 *   - Filtre étage : uniquement le niveau sélectionné.
 *   - Filtre statut : résultat exact.
 *   - Photos : bonnes photos liées aux bonnes réserves.
 *
 * Les filtres sont vérifiés sur la clause SQL produite : c'est elle, et rien
 * d'autre, qui décide des réserves lues. Un filtre correct dans l'écran mais
 * absent de la clause laisserait passer les réserves d'une autre entreprise.
 */

const { Readable } = require('node:stream');
const { Op } = require('sequelize');
const sharp = require('sharp');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
}));
jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const modeles = require('../models/index.js');
const { reinitialiser } = require('./helpers/modelesRapportMock.js');
const donnees = require('../modules/rapport/service/rapportDonnees.service.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');

const CHANTIER = '22222222-2222-4222-8222-222222222222';
const BAT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const R3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const A302 = 'aaaaaaaa-0000-4000-8000-000000000302';
const ETRANGER = '99999999-9999-4999-8999-999999999999';

/** Une image PNG réelle, de la couleur donnée — reconnaissable ensuite. */
const png = (couleur) => sharp({
  create: { width: 6, height: 4, channels: 3, background: couleur },
}).png().toBuffer();

beforeEach(() => {
  reinitialiser(modeles);
  mockOuvrirFichier.mockReset().mockResolvedValue(null);
});

/* ══════════════════════════════════════════════════════════════════════════
   § 4 et § 10 — lecture des filtres
   ══════════════════════════════════════════════════════════════════════════ */

describe('normalisation des filtres', () => {
  it('lit la configuration EXACTE de l’exemple du § 10', () => {
    const f = donnees.normaliserFiltres({
      building_id: 'BAT_A',
      levels: ['R+3'],
      company_id: 'ENT045',
      statuses: ['A_TRAITER', 'EN_COURS'],
    });

    expect(f.batiments).toEqual(['BAT_A']);
    expect(f.etages).toEqual(['R+3']);
    expect(f.entreprises).toEqual(['ENT045']);
    expect(f.statuts).toEqual(['A_TRAITER', 'EN_COURS']);
  });

  it('lit aussi le vocabulaire de l’application', () => {
    const f = donnees.normaliserFiltres({
      batiments: [BAT_A], etages: [R3], zones: [A302],
      entreprises: ['p1', 'p2'], corpsEtat: ['c1'],
      statuts: ['levee'], gravites: ['critique', 'mineure'],
      dateDebut: '2026-09-01', dateFin: '2026-09-30',
    });

    expect(f.zones).toEqual([A302]);
    expect(f.entreprises).toEqual(['p1', 'p2']);
    // La casse n'est pas une faute : « levee » vaut « LEVEE ».
    expect(f.statuts).toEqual(['LEVEE']);
    expect(f.gravites).toEqual(['CRITIQUE', 'MINEURE']);
    expect(f.dateDebut).toBe('2026-09-01');
    expect(f.dateFin).toBe('2026-09-30');
  });

  it('écarte un statut ou une gravité inconnus plutôt que de les inventer', () => {
    const f = donnees.normaliserFiltres({ statuts: ['A_TRAITER', 'PERDU'], gravites: ['ENORME'] });
    expect(f.statuts).toEqual(['A_TRAITER']);
    expect(f.gravites).toEqual([]);
  });

  it('remet à l’endroit une période saisie à l’envers', () => {
    const f = donnees.normaliserFiltres({ date_from: '2026-09-30', date_to: '2026-09-01' });
    expect(f.dateDebut).toBe('2026-09-01');
    expect(f.dateFin).toBe('2026-09-30');
  });

  it('un modèle pose son périmètre sans écraser le choix de l’utilisateur', () => {
    const vide = donnees.appliquerDefautsModele(donnees.normaliserFiltres({}), R.MODELES.A_TRAITER);
    expect(vide.statuts).toEqual(['A_TRAITER', 'EN_COURS', 'A_CONTROLER']);

    const choisi = donnees.appliquerDefautsModele(
      donnees.normaliserFiltres({ statuts: ['A_TRAITER'] }), R.MODELES.A_TRAITER,
    );
    expect(choisi.statuts).toEqual(['A_TRAITER']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 23 — la clause SQL : c'est elle qui décide du périmètre
   ══════════════════════════════════════════════════════════════════════════ */

describe('§ 23 — filtres appliqués à la lecture', () => {
  const where = (filtres) => donnees.construireWhere(CHANTIER, donnees.normaliserFiltres(filtres));

  it('Rapport global : aucune restriction autre que le chantier', () => {
    expect(where({})).toEqual({ chantierId: CHANTIER });
  });

  it('Filtre entreprise : la clause exclut toute autre entreprise', () => {
    expect(where({ company_id: 'p1' }).partenaireId).toEqual({ [Op.in]: ['p1'] });
  });

  it('Filtre étage : uniquement le niveau sélectionné', () => {
    expect(where({ etages: [R3] }).etageId).toEqual({ [Op.in]: [R3] });
  });

  it('Filtre statut : les statuts RÉELS exacts, ni plus ni moins', () => {
    expect(where({ statuts: ['A_CONTROLER'] }).statut).toEqual({ [Op.in]: ['corrigee', 'a_verifier'] });
    expect(where({ statuts: ['LEVEE'] }).statut).toEqual({ [Op.in]: ['validee'] });
  });

  it('Filtre gravité : « Majeure » vise la sévérité « haute »', () => {
    expect(where({ gravites: ['MAJEURE'] }).severite).toEqual({ [Op.in]: ['haute'] });
  });

  it('Période : bornée sur la date de création, jour de fin INCLUS', () => {
    const w = where({ date_from: '2026-09-01', date_to: '2026-09-30' });
    expect(w.createdAt[Op.gte]).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(w.createdAt[Op.lte]).toEqual(new Date('2026-09-30T23:59:59.999Z'));
  });

  it('un statut brut de l’ancien écran prime sur les statuts du rapport', () => {
    const w = where({ statut: 'en_retard', statuts: ['A_TRAITER'] });
    expect(w.statut).toEqual({ [Op.in]: ['en_retard'] });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Résolution des libellés — le « R+3 » du § 10
   ══════════════════════════════════════════════════════════════════════════ */

describe('résolution des filtres sur la structure du chantier', () => {
  beforeEach(() => {
    modeles.Batiment.findAll.mockResolvedValue([{
      id: BAT_A, nom: 'A', code: 'BAT_A',
      etages: [{ id: R3, nom: 'R+3', codeNiveau: 'R+3', zones: [{ id: A302, nom: 'A302' }] }],
    }]);
  });

  it('traduit libellés et codes en identifiants', async () => {
    const { filtres, inconnus } = await donnees.resoudreFiltres(CHANTIER, {
      building_id: 'BAT_A', levels: ['R+3'], zone_ids: ['A302'],
    });

    expect(filtres.batiments).toEqual([BAT_A]);
    expect(filtres.etages).toEqual([R3]);
    expect(filtres.zones).toEqual([A302]);
    expect(Object.values(inconnus).flat()).toEqual([]);
  });

  it('un identifiant d’un AUTRE chantier est signalé, jamais appliqué', async () => {
    // § 21 : protection contre l'accès à un autre chantier par modification
    // d'identifiant. L'appliquer tel quel donnerait un rapport vide mais
    // prouverait l'existence de l'étage ; l'ignorer élargirait le rapport.
    const { filtres, inconnus } = await donnees.resoudreFiltres(CHANTIER, { etages: [ETRANGER] });

    expect(filtres.etages).toEqual([]);
    expect(inconnus.etages).toEqual([ETRANGER]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Synthèse et regroupement
   ══════════════════════════════════════════════════════════════════════════ */

describe('synthèse (§ 6, page 2)', () => {
  const fiche = (statutRapport, gravite, entreprise) => ({ statutRapport, gravite, entreprise });

  it('la somme des colonnes est toujours égale au total', () => {
    const s = donnees.construireSynthese([
      fiche('A_TRAITER', 'CRITIQUE', 'ABC'),
      fiche('EN_COURS', 'MAJEURE', 'ABC'),
      fiche('A_CONTROLER', 'MINEURE', 'XYZ'),
      fiche('LEVEE', null, 'XYZ'),
      fiche('CLOTUREE', 'MINEURE', null),
    ]);

    expect(s.total).toBe(5);
    expect(Object.values(s.parStatut).reduce((a, b) => a + b, 0)).toBe(5);
    expect(Object.values(s.parGravite).reduce((a, b) => a + b, 0) + s.graviteNonRenseignee).toBe(5);
    expect(s.graviteNonRenseignee).toBe(1);
  });

  it('répartit par entreprise, la plus chargée d’abord', () => {
    const s = donnees.construireSynthese([
      fiche('A_TRAITER', 'CRITIQUE', 'XYZ'),
      fiche('A_TRAITER', 'CRITIQUE', 'ABC'),
      fiche('LEVEE', 'CRITIQUE', 'ABC'),
    ]);

    expect(s.parEntreprise[0]).toMatchObject({ entreprise: 'ABC', total: 2, A_TRAITER: 1, LEVEE: 1 });
    expect(s.parEntreprise[1]).toMatchObject({ entreprise: 'XYZ', total: 1 });
  });

  it('le rapport « à traiter » met le retard en tête et l’absence d’échéance en dernier', () => {
    const groupes = donnees.grouperFiches([
      { numero: '1', statutReserve: 'creee', dateLimite: null },
      { numero: '2', statutReserve: 'affectee', dateLimite: '2026-09-20' },
      { numero: '3', statutReserve: 'en_retard', dateLimite: '2026-09-01' },
      { numero: '4', statutReserve: 'affectee', dateLimite: '2026-09-10' },
    ], 'echeance');

    expect(groupes.map((g) => g.libelle)).toEqual(['En retard', 'Avec échéance', 'Sans échéance']);
    expect(groupes[1].reserves.map((r) => r.numero)).toEqual(['4', '2']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   § 17 — les faits de la levée, lus dans l'historique
   ══════════════════════════════════════════════════════════════════════════ */

describe('analyse de l’historique (§ 17)', () => {
  const personne = (prenom, nom) => ({ prenom, nom });

  it('tire la correction, le demandeur, le contrôleur et l’état initial', () => {
    const a = donnees.analyserHistorique([
      { action: 'creation', nouvelles_valeurs: { statut: 'creee' }, createdAt: new Date('2026-09-01') },
      { action: 'statut', nouvelles_valeurs: { statut: 'corrigee' }, createdAt: new Date('2026-09-05'), utilisateur: personne('Awa', 'Diop') },
      { action: 'validation', nouvelles_valeurs: { statut: 'validee' }, createdAt: new Date('2026-09-06'), utilisateur: personne('Paul', 'Martin') },
    ]);

    expect(a.statutInitial).toBe('creee');
    expect(a.dateCorrection).toEqual(new Date('2026-09-05'));
    expect(a.demandeurLevee).toBe('Awa Diop');
    expect(a.controleur).toBe('Paul Martin');
    expect(a.dateValidation).toEqual(new Date('2026-09-06'));
  });

  it('après un refus, c’est la DERNIÈRE correction qui fait foi', () => {
    const a = donnees.analyserHistorique([
      { action: 'statut', nouvelles_valeurs: { statut: 'corrigee' }, createdAt: new Date('2026-09-02'), utilisateur: personne('A', 'Un') },
      { action: 'refus', nouvelles_valeurs: { statut: 'refusee' }, createdAt: new Date('2026-09-03') },
      { action: 'statut', nouvelles_valeurs: { statut: 'a_verifier' }, createdAt: new Date('2026-09-08'), utilisateur: personne('B', 'Deux') },
    ]);

    expect(a.dateCorrection).toEqual(new Date('2026-09-08'));
    expect(a.demandeurLevee).toBe('B Deux');
  });

  it('sans historique, rien n’est deviné', () => {
    expect(donnees.analyserHistorique([])).toEqual({
      dateCorrection: null, demandeurLevee: null, controleur: null, dateValidation: null, statutInitial: null,
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   chargerVue — la lecture complète
   ══════════════════════════════════════════════════════════════════════════ */

describe('chargement complet d’un rapport', () => {
  /** Réserve telle que Sequelize la renverrait, includes compris. */
  const reserve = (surcharge = {}) => ({
    id: 'r1',
    numero: 'R-0125',
    titre: 'Faïence cassée',
    description: 'Salle de bain, mur nord.',
    statut: 'en_cours',
    severite: 'haute',
    partenaireId: 'p45',
    createdAt: new Date('2026-09-01T08:00:00Z'),
    date_limite: '2026-09-15',
    batiment: { nom: 'Bâtiment A' },
    etage: { nom: 'R+3' },
    zone: { nom: 'A302' },
    partenaire: { id: 'p45', nom: 'ENT045' },
    corpsEtat: { nom: 'Carrelage' },
    plan: { id: 'plan-1', nom: 'PLAN_A_R3_302_V02', format: 'pdf', fichier_url: null },
    position: { x: 62.35, y: 41.8, page: 1 },
    medias: [],
    ...surcharge,
  });

  const charger = (surcharge = {}) => donnees.chargerVue({
    chantier: { id: CHANTIER, nom: 'Résidence Les Jardins' },
    organisation: { nom: 'Widjila BTP' },
    filtres: donnees.normaliserFiltres({}),
    modeleDef: R.MODELES.GLOBAL,
    sections: { ...R.SECTIONS_PAR_DEFAUT },
    auteur: 'Balla Beye',
    ...surcharge,
  });

  it('reproduit la donnée d’exemple du § 8, coordonnées NORMALISÉES', async () => {
    modeles.Reserve.findAll.mockResolvedValue([reserve()]);

    const vue = await charger();
    const [f] = vue.reserves;

    expect(f.numero).toBe('R-0125');
    expect(f.titre).toBe('Faïence cassée');
    expect(f.entreprise).toBe('ENT045');
    expect(f.gravite).toBe('MAJEURE');
    expect(f.statutRapport).toBe('EN_COURS');
    expect(f.dateLimite).toBe('2026-09-15');
    // Stockée en pourcentage (62,35 %), exposée en coordonnée normalisée.
    expect(f.plan.x).toBeCloseTo(0.6235, 6);
    expect(f.plan.y).toBeCloseTo(0.418, 6);
    expect(f.plan.page).toBe(1);
    expect(f.localisation).toBe('Bâtiment A › R+3 › A302');
  });

  it('interroge la base avec la clause des filtres', async () => {
    await charger({ filtres: donnees.normaliserFiltres({ company_id: 'p45', statuses: ['EN_COURS'] }) });

    const { where } = modeles.Reserve.findAll.mock.calls[0][0];
    expect(where.chantierId).toBe(CHANTIER);
    expect(where.partenaireId).toEqual({ [Op.in]: ['p45'] });
    expect(where.statut).toEqual({ [Op.in]: ['prise_en_charge', 'en_cours'] });
  });

  it('§ 23 — Photos : les bonnes photos liées aux bonnes réserves', async () => {
    const rouge = await png('#ff0000');
    const bleu = await png('#0000ff');
    const fichiers = { '/uploads/photos/r1.png': rouge, '/uploads/photos/r2.png': bleu };
    mockOuvrirFichier.mockImplementation(async (url) => (
      fichiers[url] ? { stream: Readable.from([fichiers[url]]) } : null
    ));

    modeles.Reserve.findAll.mockResolvedValue([
      reserve({ id: 'r1', numero: 'R-1', medias: [{ id: 'm1', type: 'photo', url: '/uploads/photos/r1.png', createdAt: new Date() }] }),
      reserve({ id: 'r2', numero: 'R-2', medias: [{ id: 'm2', type: 'photo', url: '/uploads/photos/r2.png', createdAt: new Date() }] }),
    ]);

    const vue = await charger();

    expect(vue.reserves[0].photos[0].buffer.equals(rouge)).toBe(true);
    expect(vue.reserves[1].photos[0].buffer.equals(bleu)).toBe(true);
    expect(vue.nbPhotos).toBe(2);
  });

  it('une photo illisible fait perdre la photo, jamais le rapport', async () => {
    mockOuvrirFichier.mockRejectedValue(new Error('R2 injoignable'));
    modeles.Reserve.findAll.mockResolvedValue([
      reserve({ medias: [{ id: 'm1', type: 'photo', url: '/uploads/photos/x.png' }] }),
    ]);

    const vue = await charger();

    expect(vue.reserves).toHaveLength(1);
    expect(vue.reserves[0].photos).toEqual([]);
  });

  it('§ 17 — la levée : photo avant, photo après, demandeur, contrôleur', async () => {
    const avant = await png('#aa0000');
    const apres = await png('#00aa00');
    mockOuvrirFichier.mockImplementation(async (url) => {
      if (url.endsWith('avant.png')) return { stream: Readable.from([avant]) };
      if (url.endsWith('apres.png')) return { stream: Readable.from([apres]) };
      return null;
    });

    modeles.Reserve.findAll.mockResolvedValue([reserve({
      statut: 'validee',
      date_validation: new Date('2026-09-06T10:00:00Z'),
      medias: [
        { id: 'a', type: 'photo', url: '/uploads/photos/avant.png', pris_le: new Date('2026-09-02T09:00:00Z') },
        { id: 'b', type: 'photo', url: '/uploads/photos/apres.png', pris_le: new Date('2026-09-05T15:00:00Z') },
      ],
    })]);
    modeles.ReserveHistorique.findAll.mockResolvedValue([
      { reserveId: 'r1', action: 'creation', nouvelles_valeurs: { statut: 'creee' }, createdAt: new Date('2026-09-01T08:00:00Z') },
      {
        reserveId: 'r1', action: 'statut', anciennes_valeurs: { statut: 'en_cours' }, nouvelles_valeurs: { statut: 'corrigee' },
        createdAt: new Date('2026-09-05T14:00:00Z'), utilisateur: { prenom: 'Awa', nom: 'Diop' },
      },
      {
        reserveId: 'r1', action: 'validation', anciennes_valeurs: { statut: 'corrigee' }, nouvelles_valeurs: { statut: 'validee' },
        createdAt: new Date('2026-09-06T10:00:00Z'), utilisateur: { prenom: 'Paul', nom: 'Martin' },
      },
    ]);

    const vue = await charger({ modeleDef: R.MODELES.LEVEES, sections: { ...R.MODELES.LEVEES.sectionsParDefaut } });
    const [f] = vue.reserves;

    // La photo prise AVANT la déclaration de correction montre le défaut ;
    // celle prise APRÈS montre la correction.
    expect(f.photosAvant[0].buffer.equals(avant)).toBe(true);
    expect(f.photosApres[0].buffer.equals(apres)).toBe(true);
    expect(f.levee).toMatchObject({
      statutInitial: 'Créée',
      entreprise: 'ENT045',
      demandeur: 'Awa Diop',
      controleur: 'Paul Martin',
      statutFinal: 'Validée',
    });
    expect(f.levee.dateCorrection).toEqual(new Date('2026-09-05T14:00:00Z'));
    // L'historique est lisible sur le document, sans flèche que la police
    // standard du PDF ne sait pas dessiner.
    expect(f.historique.map((h) => h.detail)).toContain('En cours > Corrigée');
  });

  it('l’historique n’est pas lu quand la section est éteinte', async () => {
    modeles.Reserve.findAll.mockResolvedValue([reserve()]);

    await charger({ sections: { ...R.SECTIONS_PAR_DEFAUT, history: false } });

    expect(modeles.ReserveHistorique.findAll).not.toHaveBeenCalled();
  });
});
