'use strict';

/**
 * Tests — incrustation des plans et pose de la pastille (§ 7 du cahier des
 * charges), et le critère d'acceptation du § 23 : « Plan : pastille au bon
 * emplacement ».
 *
 * La position est vérifiée PAR LE CALCUL (`calculerPlacement`), pas à l'œil :
 * une pastille décalée de dix points sur un plan de niveau envoie une
 * entreprise dans le mauvais appartement, et aucun test visuel ne le
 * rattraperait sur des centaines de rapports.
 *
 * L'incrustation elle-même est ensuite exercée sur un VRAI plan PDF.
 */

const PDFKit = require('pdfkit');
const { PDFDocument, degrees } = require('pdf-lib');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());
jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  incrusterPlans, calculerPlacement, dimensionsAffichees, ZOOM_EXTRAIT,
} = require('../modules/rapport/service/rapportPlans.js');
const { construireRapport, HAUTEUR_PAGE } = require('../modules/rapport/service/rapportPdf.js');
const { construireSynthese, grouperFiches } = require('../modules/rapport/service/rapportDonnees.service.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');

/** Dimensions d'un plan affiché sans rotation. */
const plat = (largeur, hauteur) => ({
  angle: 0, largeur, hauteur, largeurSource: largeur, hauteurSource: hauteur,
});

/** Emplacement réservé par la première passe (coordonnées pdfkit). */
const emplacement = (surcharge = {}) => ({
  page: 2, planId: 'plan-1', pagePlan: 1,
  x: 52, y: 300, largeur: 250, hauteur: 150,
  xNorm: 0.6235, yNorm: 0.418, mode: 'complet',
  ...surcharge,
});

/** Un vrai plan PDF, produit à la volée. */
function planPdf({ largeur = 800, hauteur = 600 } = {}) {
  return new Promise((resolve) => {
    const doc = new PDFKit({ size: [largeur, hauteur], margin: 0 });
    const morceaux = [];
    doc.on('data', (b) => morceaux.push(b));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.rect(20, 20, largeur - 40, hauteur - 40).lineWidth(4).stroke('#333333');
    doc.moveTo(largeur / 2, 20).lineTo(largeur / 2, hauteur - 20).stroke('#333333');
    doc.end();
  });
}

describe('§ 23 — la pastille au bon emplacement', () => {
  it('plan complet : la pastille tombe à 62,35 % / 41,80 % du plan DESSINÉ', () => {
    const p = calculerPlacement(emplacement(), plat(800, 600), HAUTEUR_PAGE);

    // Plan 800×600 dans un cadre 250×150 : échelle 0,25, dessin 200×150,
    // centré horizontalement (marge de 25 de chaque côté).
    expect(p.echelle).toBeCloseTo(0.25, 6);
    expect(p.dessin.largeur).toBeCloseTo(200, 6);
    expect(p.dessin.hauteur).toBeCloseTo(150, 6);
    expect(p.dessin.x).toBeCloseTo(77, 6);

    // pdf-lib compte depuis le BAS de la page ; `yNorm` depuis le HAUT du plan.
    const basCadre = HAUTEUR_PAGE - 300 - 150;
    expect(p.pastille.x).toBeCloseTo(77 + 0.6235 * 200, 6);
    expect(p.pastille.y).toBeCloseTo(basCadre + 150 - 0.418 * 150, 6);
  });

  it('la pastille reste à la même position RELATIVE quelle que soit la taille du cadre', () => {
    // C'est la promesse des coordonnées normalisées du § 7 : « indépendamment
    // de la taille d'affichage ».
    for (const [largeur, hauteur] of [[250, 150], [500, 300], [120, 90]]) {
      const p = calculerPlacement(emplacement({ largeur, hauteur }), plat(800, 600), HAUTEUR_PAGE);
      expect((p.pastille.x - p.dessin.x) / p.dessin.largeur).toBeCloseTo(0.6235, 6);
      expect((p.dessin.y + p.dessin.hauteur - p.pastille.y) / p.dessin.hauteur).toBeCloseTo(0.418, 6);
    }
  });

  it('extrait zoomé : la réserve est au CENTRE du cadre', () => {
    const p = calculerPlacement(emplacement({ mode: 'extrait', xNorm: 0.5, yNorm: 0.5 }), plat(800, 600), HAUTEUR_PAGE);

    expect(p.echelle).toBeCloseTo(0.25 * ZOOM_EXTRAIT, 6);
    expect(p.pastille.x).toBeCloseTo(52 + 125, 6);
    expect(p.pastille.y).toBeCloseTo(HAUTEUR_PAGE - 300 - 150 + 75, 6);
  });

  it('extrait près d’un bord : le plan ne sort pas du cadre, la pastille reste dedans', () => {
    const p = calculerPlacement(emplacement({ mode: 'extrait', xNorm: 0.02, yNorm: 0.97 }), plat(800, 600), HAUTEUR_PAGE);
    const cadre = p.cadre;

    // Le dessin couvre tout le cadre (pas de vide montré à la place du plan)…
    expect(p.dessin.x).toBeLessThanOrEqual(cadre.x);
    expect(p.dessin.x + p.dessin.largeur).toBeGreaterThanOrEqual(cadre.x + cadre.largeur);
    // … et la pastille est bien à l'intérieur.
    expect(p.pastille.x).toBeGreaterThanOrEqual(cadre.x);
    expect(p.pastille.x).toBeLessThanOrEqual(cadre.x + cadre.largeur);
    expect(p.pastille.y).toBeGreaterThanOrEqual(cadre.y);
    expect(p.pastille.y).toBeLessThanOrEqual(cadre.y + cadre.hauteur);
  });

  it('sans position connue, aucune pastille n’est inventée', () => {
    const p = calculerPlacement(emplacement({ xNorm: null, yNorm: null, mode: 'extrait' }), plat(800, 600), HAUTEUR_PAGE);
    expect(p.pastille).toBeNull();
    // Et l'extrait retombe sur le plan entier : zoomer sur rien n'a pas de sens.
    expect(p.echelle).toBeCloseTo(0.25, 6);
  });
});

describe('plans tournés', () => {
  it('une page « /Rotate 90 » est traitée dans son sens d’AFFICHAGE', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([800, 600]);
    page.setRotation(degrees(90));

    const dims = dimensionsAffichees(page);
    expect(dims).toMatchObject({ angle: 90, largeur: 600, hauteur: 800, largeurSource: 800, hauteurSource: 600 });

    // La pastille se place sur le plan tel que l'utilisateur l'a VU.
    const p = calculerPlacement(emplacement(), dims, HAUTEUR_PAGE);
    expect((p.pastille.x - p.dessin.x) / p.dessin.largeur).toBeCloseTo(0.6235, 6);
    expect(p.dessin.hauteur / p.dessin.largeur).toBeCloseTo(800 / 600, 6);
  });
});

describe('incrustation dans le rapport réel', () => {
  /** Un rapport d'une réserve posée sur `plan-1`. */
  async function rapportAvecPlan(plan, position = { x: 0.6235, y: 0.418 }) {
    const reserves = [{
      id: 'r1', numero: 'R-0125', titre: 'Faïence cassée', statutRapport: 'EN_COURS',
      statutRapportLibelle: 'En cours', gravite: 'MAJEURE', graviteLibelle: 'Majeure',
      localisation: 'A › R+3 › A302', photos: [], historique: [],
      plan: { id: 'plan-1', nom: 'PLAN_A', page: 1, ...position },
      levee: {},
    }];
    const plans = new Map([['plan-1', { id: 'plan-1', buffer: plan, image: null }]]);
    const compose = await construireRapport({
      reserves,
      groupes: grouperFiches(reserves, 'localisation'),
      synthese: construireSynthese(reserves),
      sections: { ...R.SECTIONS_PAR_DEFAUT },
      modeleDef: R.MODELES.GLOBAL,
      plans,
      chantier: { nom: 'Résidence' },
    });
    return { ...compose, plans };
  }

  it('incruste le plan en VECTORIEL, sans ajouter ni retirer de page', async () => {
    const { buffer, emplacements, plans } = await rapportAvecPlan(await planPdf());
    expect(emplacements).toHaveLength(2);

    const resultat = await incrusterPlans(buffer, emplacements, plans, HAUTEUR_PAGE);

    const avant = await PDFDocument.load(buffer);
    const apres = await PDFDocument.load(resultat);
    expect(apres.getPageCount()).toBe(avant.getPageCount());
    // pdf-lib incorpore la page du plan comme un « Form XObject » : c'est la
    // preuve que le plan est dessiné en vectoriel, pas rastérisé.
    expect(resultat.toString('latin1')).toMatch(/\/Subtype\s*\/Form/);
    expect(buffer.toString('latin1')).not.toMatch(/\/Subtype\s*\/Form/);
  });

  it('un plan tourné s’incruste en vectoriel', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([800, 600]);
    page.drawRectangle({ x: 20, y: 20, width: 760, height: 560, borderWidth: 4 });
    page.setRotation(degrees(90));
    const plan = Buffer.from(await doc.save());

    const { buffer, emplacements, plans } = await rapportAvecPlan(plan);
    const resultat = await incrusterPlans(buffer, emplacements, plans, HAUTEUR_PAGE);

    expect((await PDFDocument.load(resultat)).getPageCount()).toBe((await PDFDocument.load(buffer)).getPageCount());
    expect(resultat.toString('latin1')).toMatch(/\/Subtype\s*\/Form/);
  });

  it('une page de plan VIDE est annoncée indisponible, sans faire échouer le rapport', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([800, 600]); // aucune instruction de dessin : pas de /Contents
    const plan = Buffer.from(await doc.save());

    const { buffer, emplacements, plans } = await rapportAvecPlan(plan);
    const resultat = await incrusterPlans(buffer, emplacements, plans, HAUTEUR_PAGE);

    expect((await PDFDocument.load(resultat)).getPageCount()).toBe((await PDFDocument.load(buffer)).getPageCount());
  });

  it('un plan corrompu ne coûte pas le rapport', async () => {
    const { buffer, emplacements, plans } = await rapportAvecPlan(Buffer.from('%PDF-1.4 fichier cassé'));

    const resultat = await incrusterPlans(buffer, emplacements, plans, HAUTEUR_PAGE);

    const doc = await PDFDocument.load(resultat);
    expect(doc.getPageCount()).toBe((await PDFDocument.load(buffer)).getPageCount());
  });

  it('sans emplacement, le document est rendu tel quel', async () => {
    const original = Buffer.from('%PDF-1.4 original');
    await expect(incrusterPlans(original, [], new Map(), HAUTEUR_PAGE)).resolves.toBe(original);
  });

  it('une page de plan hors bornes retombe sur la première, sans échouer', async () => {
    const { buffer, emplacements, plans } = await rapportAvecPlan(await planPdf());
    const decales = emplacements.map((e) => ({ ...e, pagePlan: 9 }));

    const resultat = await incrusterPlans(buffer, decales, plans, HAUTEUR_PAGE);
    expect(resultat.toString('latin1')).toMatch(/\/Subtype\s*\/Form/);
  });
});
