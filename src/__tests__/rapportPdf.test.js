'use strict';

/**
 * Tests — modules/rapport/service/rapportPdf.js
 *
 * Le générateur est testé POUR DE VRAI : on construit un PDF complet en
 * mémoire et on en lit le texte. Un test qui se contenterait de vérifier que
 * la fonction ne lève pas laisserait passer exactement les défauts qui
 * comptent — une section absente, un « undefined » imprimé, une page blanche.
 *
 * Ce qui est verrouillé ici, point par point du cahier des charges :
 *
 *   § 6  page 1 couverture, page 2 synthèse, puis le détail ;
 *   § 6  chaque fiche porte ses onze éléments ;
 *   § 6  l'historique n'apparaît QUE s'il est activé ;
 *   § 7  un emplacement de plan porte les coordonnées normalisées ;
 *   § 17 la fiche de levée porte ses neuf informations ;
 *   § 20 la prévisualisation est marquée comme telle ;
 *   § 23 « PDF : pagination correcte et aucune coupure ».
 */

const sharp = require('sharp');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const {
  construireRapport, val, dateFr, LIBELLE_STATUT, LIBELLE_SEVERITE,
} = require('../modules/rapport/service/rapportPdf.js');
const { construireSynthese, grouperFiches } = require('../modules/rapport/service/rapportDonnees.service.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');
const { lireTextePdf, lireTextePdfNormalise } = require('./helpers/lireTextePdf.js');

/** Nombre réel de pages, compté sur les objets `/Type /Page`. */
function nombreDePages(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/** Une fiche de réserve telle que `rapportDonnees.service.js` la produit. */
function fiche(n, surcharge = {}) {
  return {
    id: `r${n}`,
    numero: `R-${String(n).padStart(4, '0')}`,
    titre: `Défaut ${n}`,
    description: `Description du défaut ${n}.`,
    statutReserve: 'en_cours',
    statutDetail: 'En cours',
    statutRapport: 'EN_COURS',
    statutRapportLibelle: 'En cours',
    severite: 'haute',
    gravite: 'MAJEURE',
    graviteLibelle: 'Majeure',
    batiment: 'Bâtiment A',
    etage: 'R+3',
    zone: 'A302',
    localisation: 'Bâtiment A › R+3 › A302',
    entrepriseId: 'p45',
    entreprise: 'ENT045',
    corpsEtat: 'Carrelage',
    lot: null,
    dateCreation: new Date('2026-09-01T08:00:00Z'),
    dateLimite: '2026-09-15',
    dateValidation: null,
    dateCorrection: null,
    photos: [],
    photosAvant: [],
    photosApres: [],
    plan: null,
    historique: [],
    levee: {
      statutInitial: null, dateCorrection: null, entreprise: 'ENT045',
      demandeur: null, controleur: null, dateValidation: null, statutFinal: 'En cours',
    },
    ...surcharge,
  };
}

/** Données complètes d'un rapport. */
function vue(surcharge = {}) {
  const reserves = surcharge.reserves || [fiche(1), fiche(2)];
  const modeleDef = surcharge.modeleDef || R.MODELES.BATIMENT;
  return {
    titre: 'Rapport Bâtiment A',
    modeleLibelle: modeleDef.libelle,
    reference: 'RJ-2026',
    version: 1,
    dateRapport: new Date('2026-09-10T10:00:00Z'),
    auteur: 'Balla Beye',
    chantier: { nom: 'Résidence Les Jardins', code: 'RJ-2026', adresse: '10 rue de la Paix, Dakar' },
    organisation: { nom: 'Widjila BTP' },
    perimetre: {
      localisation: 'A, R+3',
      entreprises: 'ENT045',
      statuts: 'À traiter, En cours',
      periode: 'Du 01/09/2026 au 30/09/2026',
    },
    sections: { ...R.SECTIONS_PAR_DEFAUT },
    modeleDef,
    reserves,
    groupes: grouperFiches(reserves, modeleDef.groupement),
    synthese: construireSynthese(reserves),
    plans: new Map(),
    nbPhotos: 0,
    logos: {},
    ...surcharge,
  };
}

const png = (couleur = '#888888', largeur = 40, hauteur = 30) => sharp({
  create: { width: largeur, height: hauteur, channels: 3, background: couleur },
}).png().toBuffer();

describe('helpers — la règle « aucune invention »', () => {
  it('remplace toute donnée absente par un libellé explicite', () => {
    expect(val(null)).toBe('Non renseigné');
    expect(val('')).toBe('Non renseigné');
    expect(val('   ')).toBe('Non renseigné');
    expect(val(0)).toBe('0');
  });

  it('n’invente jamais de date', () => {
    expect(dateFr(null)).toBe('Non renseigné');
    expect(dateFr('pas-une-date')).toBe('Non renseigné');
    expect(dateFr('2026-09-15')).toBe('15/09/2026');
  });

  it('couvre tous les statuts et sévérités de la base', () => {
    for (const s of ['creee', 'affectee', 'prise_en_charge', 'en_cours', 'corrigee',
      'a_verifier', 'validee', 'refusee', 'rouverte', 'en_retard', 'cloturee']) {
      expect(LIBELLE_STATUT[s]).toBeDefined();
    }
    for (const s of ['faible', 'moyenne', 'haute', 'critique']) expect(LIBELLE_SEVERITE[s]).toBeDefined();
  });
});

describe('§ 6 — structure du document', () => {
  it('produit un PDF valide et la liste des emplacements de plan', async () => {
    const { buffer, emplacements } = await construireRapport(vue());

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Array.isArray(emplacements)).toBe(true);
  });

  it('page 1 couverture, page 2 synthèse, puis le détail — dans cet ordre', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue())).buffer);

    // Couverture : les cinq éléments du § 6.
    for (const element of ['PROJET', 'BATIMENT / ZONE', 'PERIODE', 'DATE DE GENERATION', 'RESIDENCE LES JARDINS']) {
      expect(texte).toContain(element);
    }
    expect(texte).toContain('DU 01/09/2026 AU 30/09/2026');

    const couverture = texte.indexOf('DATE DE GENERATION');
    const synthese = texte.indexOf('SYNTHESE');
    const detail = texte.indexOf('DETAIL DES RESERVES');
    expect(couverture).toBeGreaterThan(-1);
    expect(synthese).toBeGreaterThan(couverture);
    expect(detail).toBeGreaterThan(synthese);
  });

  it('la couverture est SEULE sur sa page', async () => {
    // Sans réserve : couverture + synthèse + détail (vide) + rien d'autre.
    const { buffer } = await construireRapport(vue({ reserves: [] }));
    expect(nombreDePages(buffer)).toBe(3);
  });

  it('la synthèse porte les huit éléments du § 6', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue())).buffer);

    for (const element of [
      'TOTAL DES RESERVES', 'A TRAITER', 'EN COURS', 'A CONTROLER', 'LEVEES', 'CLOTUREES',
      'REPARTITION PAR GRAVITE', 'REPARTITION PAR ENTREPRISE',
    ]) {
      expect(texte).toContain(element);
    }
  });

  it('sans la section « summary », pas de synthèse', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue({
      sections: { ...R.SECTIONS_PAR_DEFAUT, summary: false },
    }))).buffer);

    expect(texte).not.toContain('REPARTITION PAR GRAVITE');
    expect(texte).toContain('DETAIL DES RESERVES');
  });
});

describe('§ 6 — la fiche d’une réserve', () => {
  it('porte les éléments demandés', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue())).buffer);

    expect(texte).toContain('R-0001');                 // N° de réserve
    expect(texte).toContain('A302');                   // bâtiment / étage / appartement
    expect(texte).toContain('R+3');
    expect(texte).toContain('DEFAUT 1');               // observation
    expect(texte).toContain('DESCRIPTION DU DEFAUT 1');
    expect(texte).toContain('ENT045');                 // entreprise
    expect(texte).toContain('CARRELAGE');              // corps d'état
    expect(texte).toContain('MAJEURE');                // gravité
    expect(texte).toContain('DATE DE CREATION');
    expect(texte).toContain('01/09/2026');
    expect(texte).toContain('DATE LIMITE');
    expect(texte).toContain('15/09/2026');
    expect(texte).toContain('EN COURS');               // statut
  });

  it('CONSERVE la numérotation d’origine', async () => {
    const reserves = [fiche(7), fiche(42)];
    const texte = lireTextePdf((await construireRapport(vue({ reserves }))).buffer);

    expect(texte).toContain('R-0007');
    expect(texte).toContain('R-0042');
    expect(texte).not.toContain('R-0001');
  });

  it('l’historique n’apparaît QUE s’il est activé', async () => {
    const historique = [{
      date: new Date('2026-09-03T10:00:00Z'), acteur: 'Awa Diop', action: 'Changement de statut', detail: 'Créée > En cours',
    }];
    const reserves = [fiche(1, { historique })];

    const sans = lireTextePdfNormalise((await construireRapport(vue({ reserves }))).buffer);
    expect(sans).not.toContain('HISTORIQUE');

    const avec = lireTextePdfNormalise((await construireRapport(vue({
      reserves, sections: { ...R.SECTIONS_PAR_DEFAUT, history: true },
    }))).buffer);
    expect(avec).toContain('HISTORIQUE');
    expect(avec).toContain('AWA DIOP');
    expect(avec).toContain('CREEE > EN COURS');
  });

  it('montre les photos, et survit à une photo illisible', async () => {
    const photo = { buffer: await png('#c0392b'), date: new Date('2026-09-02T08:00:00Z') };
    const cassee = { buffer: Buffer.from('pas une image'), date: null };
    const reserves = [fiche(1, { photos: [photo, cassee] })];

    const { buffer } = await construireRapport(vue({ reserves }));

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(lireTextePdf(buffer)).toContain('Photo illisible');
    expect(buffer.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });
});

describe('§ 7 — plan et pastille', () => {
  const planPdf = { id: 'plan-1', buffer: Buffer.from('%PDF-1.4'), image: null, format: 'pdf' };
  const positionnee = () => fiche(1, {
    plan: { id: 'plan-1', nom: 'PLAN_A_R3_302_V02', page: 2, x: 0.6235, y: 0.418 },
  });

  it('réserve deux emplacements — plan complet et extrait — aux coordonnées normalisées', async () => {
    const { emplacements } = await construireRapport(vue({
      reserves: [positionnee()],
      plans: new Map([['plan-1', planPdf]]),
    }));

    expect(emplacements.map((e) => e.mode)).toEqual(['complet', 'extrait']);
    for (const e of emplacements) {
      expect(e.planId).toBe('plan-1');
      expect(e.pagePlan).toBe(2);
      expect(e.xNorm).toBe(0.6235);
      expect(e.yNorm).toBe(0.418);
      // Couverture (0) et synthèse (1) précèdent le détail.
      expect(e.page).toBeGreaterThanOrEqual(2);
      expect(e.largeur).toBeGreaterThan(100);
      expect(e.hauteur).toBeGreaterThan(100);
    }
  });

  it('imprime la position en clair avec le nom et la page du plan', async () => {
    const texte = lireTextePdf((await construireRapport(vue({
      reserves: [positionnee()],
      plans: new Map([['plan-1', planPdf]]),
    }))).buffer);

    expect(texte).toContain('PLAN_A_R3_302_V02');
    expect(texte).toContain('page 2');
    expect(texte).toContain('X 62.35 %');
    expect(texte).toContain('Y 41.80 %');
  });

  it('un plan IMAGE est dessiné directement, sans seconde passe', async () => {
    const image = await png('#dddddd', 80, 60);
    const { buffer, emplacements } = await construireRapport(vue({
      reserves: [positionnee()],
      plans: new Map([['plan-1', { id: 'plan-1', buffer: image, image: 'png' }]]),
    }));

    expect(emplacements).toEqual([]);
    expect(buffer.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });

  it('un plan introuvable est ANNONCÉ, et la position reste lisible', async () => {
    const texte = lireTextePdf((await construireRapport(vue({
      reserves: [positionnee()],
      plans: new Map(),
    }))).buffer);

    expect(texte).toContain('Plan introuvable dans le stockage');
    expect(texte).toContain('X 62.35 %');
  });

  it('sans la section « plans », aucun cadre de plan', async () => {
    const { emplacements, buffer } = await construireRapport(vue({
      reserves: [positionnee()],
      plans: new Map([['plan-1', planPdf]]),
      sections: { ...R.SECTIONS_PAR_DEFAUT, plans: false },
    }));

    expect(emplacements).toEqual([]);
    expect(lireTextePdf(buffer)).not.toContain('PLAN_A_R3_302_V02');
  });
});

describe('§ 17 — le rapport de levée', () => {
  it('porte l’état initial, les photos avant/après, le demandeur, le contrôleur et la validation', async () => {
    const reserves = [fiche(1, {
      statutReserve: 'validee', statutRapport: 'LEVEE', statutRapportLibelle: 'Levée', statutDetail: 'Validée',
      photosAvant: [{ buffer: await png('#aa0000'), date: new Date('2026-09-02T09:00:00Z') }],
      photosApres: [{ buffer: await png('#00aa00'), date: new Date('2026-09-05T15:00:00Z') }],
      levee: {
        statutInitial: 'Créée',
        dateCorrection: new Date('2026-09-05T14:00:00Z'),
        entreprise: 'ENT045',
        demandeur: 'Awa Diop',
        controleur: 'Paul Martin',
        dateValidation: new Date('2026-09-06T10:00:00Z'),
        statutFinal: 'Validée',
      },
    })];

    const texte = lireTextePdfNormalise((await construireRapport(vue({
      reserves, modeleDef: R.MODELES.LEVEES,
    }))).buffer);

    for (const element of [
      'ETAT INITIAL', 'CREEE',
      'AVANT', 'APRES',
      'DATE DE CORRECTION', '05/09/2026',
      'LEVEE DEMANDEE PAR', 'AWA DIOP',
      'CONTROLEE PAR', 'PAUL MARTIN',
      'DATE DE VALIDATION', '06/09/2026',
      'VALIDEE',
    ]) {
      expect(texte).toContain(element);
    }
  });

  it('sans photo après, le dit — au lieu de montrer le défaut comme preuve', async () => {
    const reserves = [fiche(1, {
      photosAvant: [{ buffer: await png('#aa0000'), date: new Date('2026-09-02T09:00:00Z') }],
      photosApres: [],
    })];

    const texte = lireTextePdfNormalise((await construireRapport(vue({ reserves, modeleDef: R.MODELES.LEVEES }))).buffer);
    expect(texte).toContain('PHOTO APRES : NON RENSEIGNEE');
  });
});

describe('modèles et prévisualisation', () => {
  it('§ 20 — la prévisualisation porte un filigrane', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue({ previsualisation: true }))).buffer);
    expect(texte).toContain('PREVISUALISATION');
  });

  it('le rapport officiel n’en porte pas', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue())).buffer);
    expect(texte).not.toContain('PREVISUALISATION');
  });

  it('le modèle OPR réserve la place des signatures', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue({ modeleDef: R.MODELES.OPR }))).buffer);
    expect(texte).toContain('SIGNATURES');
    expect(texte).toContain('ENTREPRISE');
  });

  it('le périmètre retenu est imprimé en annexe', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue())).buffer);
    expect(texte).toContain('PERIMETRE ET TRACABILITE');
    expect(texte).toContain('RESERVES INCLUSES');
  });
});

describe('aucune invention', () => {
  it('n’imprime jamais « undefined » ni « null »', async () => {
    const nue = fiche(1, {
      description: null, dateLimite: null, localisation: '', entreprise: null, corpsEtat: null,
      gravite: null, graviteLibelle: null, statutRapport: null, statutRapportLibelle: null, statutDetail: null,
    });
    const texte = lireTextePdf((await construireRapport(vue({
      reserves: [nue],
      chantier: { nom: 'Chantier X' },
      organisation: null,
      perimetre: {},
      auteur: null,
    }))).buffer);

    expect(texte).not.toMatch(/undefined/i);
    expect(texte).not.toMatch(/\bnull\b/i);
    expect(texte).toContain('Non renseigné');
  });

  it('annonce un périmètre vide plutôt que de le taire', async () => {
    const texte = lireTextePdfNormalise((await construireRapport(vue({ reserves: [] }))).buffer);
    expect(texte).toContain('AUCUNE RESERVE NE CORRESPOND');
  });
});

describe('§ 23 — pagination correcte et aucune coupure', () => {
  it('numérote « Page X / Y » à partir de la page 2, avec le bon total', async () => {
    const reserves = Array.from({ length: 40 }, (_, i) => fiche(i + 1));
    const { buffer } = await construireRapport(vue({ reserves }));
    const pages = [...lireTextePdf(buffer).matchAll(/Page (\d+) \/ (\d+)/g)];

    const total = Number(pages[0][2]);
    // La couverture porte son propre pied : la numérotation imprimée commence
    // à 2, et chaque page suivante porte son numéro, dans l'ordre.
    expect(pages.map((p) => Number(p[1]))).toEqual(Array.from({ length: total - 1 }, (_, i) => i + 2));
    expect(pages.every((p) => Number(p[2]) === total)).toBe(true);
    // Le document contient EXACTEMENT ce nombre de pages — aucune page blanche.
    expect(nombreDePages(buffer)).toBe(total);
  });

  it('tient un volume réaliste', async () => {
    const reserves = Array.from({ length: 150 }, (_, i) => fiche(i + 1));
    const { buffer } = await construireRapport(vue({ reserves }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30000);

  it('accepte un rapport entièrement vide sans lever', async () => {
    const { buffer } = await construireRapport({});
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
