'use strict';

/**
 * Tests — export Excel du rapport (§ 4, format XLSX) et le critère du § 23 :
 * « Excel : colonnes et données correctes ».
 *
 * Le classeur est RELU avec ExcelJS après écriture : c'est la seule façon de
 * vérifier ce que verra la personne qui l'ouvre — un en-tête décalé d'une
 * colonne passerait inaperçu tant qu'on ne regarde que l'objet en mémoire.
 */

const ExcelJS = require('exceljs');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const { construireExcel } = require('../modules/rapport/service/rapportExcel.js');
const { construireSynthese } = require('../modules/rapport/service/rapportDonnees.service.js');
const R = require('../modules/rapport/service/rapportReferentiel.js');

const COLONNES_ATTENDUES = [
  'N°', 'Bâtiment', 'Étage', 'Appartement / zone', 'Observation', 'Description',
  'Entreprise', 'Corps d’état', 'Lot', 'Gravité', 'Statut', 'Statut détaillé',
  'Date de création', 'Date limite', 'Date de correction', 'Date de validation',
  'Plan', 'Page du plan', 'Position X', 'Position Y', 'Photos',
];

function fiche(surcharge = {}) {
  return {
    numero: 'R-0125',
    batiment: 'Bâtiment A',
    etage: 'R+3',
    zone: 'A302',
    titre: 'Faïence cassée',
    description: 'Salle de bain, mur nord.',
    entreprise: 'ENT045',
    corpsEtat: 'Carrelage',
    lot: null,
    gravite: 'MAJEURE',
    graviteLibelle: 'Majeure',
    statutRapport: 'EN_COURS',
    statutRapportLibelle: 'En cours',
    statutDetail: 'En cours',
    dateCreation: new Date('2026-09-01T08:00:00Z'),
    dateLimite: '2026-09-15',
    dateCorrection: null,
    dateValidation: null,
    plan: { nom: 'PLAN_A_R3_302_V02', page: 1, x: 0.6235, y: 0.418 },
    photos: [{}, {}],
    historique: [{ date: new Date('2026-09-03T10:00:00Z'), acteur: 'Awa Diop', action: 'Changement de statut', detail: 'Créée > En cours' }],
    ...surcharge,
  };
}

async function lire(buffer) {
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(buffer);
  return classeur;
}

/** Valeurs d'une ligne, sans la case 0 qu'ExcelJS laisse vide. */
const ligne = (feuille, numero) => feuille.getRow(numero).values.slice(1);

function donnees(surcharge = {}) {
  const reserves = surcharge.reserves || [fiche(), fiche({ numero: 'R-0126', graviteLibelle: 'Critique', gravite: 'CRITIQUE', plan: null })];
  return {
    titre: 'Rapport Bâtiment A',
    modeleLibelle: 'Rapport par bâtiment',
    version: 2,
    dateRapport: new Date('2026-09-10T10:00:00Z'),
    auteur: 'Balla Beye',
    chantier: { nom: 'Résidence Les Jardins', code: 'RJ-2026' },
    perimetre: { localisation: 'A, R+3' },
    sections: { ...R.SECTIONS_PAR_DEFAUT },
    reserves,
    synthese: construireSynthese(reserves),
    ...surcharge,
  };
}

describe('§ 23 — Excel : colonnes et données correctes', () => {
  it('produit un classeur « Synthèse » + « Réserves »', async () => {
    const classeur = await lire(await construireExcel(donnees()));
    expect(classeur.worksheets.map((f) => f.name)).toEqual(['Synthèse', 'Réserves']);
  });

  it('les colonnes de la feuille des réserves sont exactement celles attendues', async () => {
    const feuille = (await lire(await construireExcel(donnees()))).getWorksheet('Réserves');
    expect(ligne(feuille, 1)).toEqual(COLONNES_ATTENDUES);
  });

  it('une ligne par réserve, avec ses données', async () => {
    const feuille = (await lire(await construireExcel(donnees()))).getWorksheet('Réserves');
    const col = (titre) => COLONNES_ATTENDUES.indexOf(titre) + 1;
    const premiere = feuille.getRow(2);

    expect(feuille.rowCount).toBe(3); // en-tête + deux réserves
    expect(premiere.getCell(col('N°')).value).toBe('R-0125');
    expect(premiere.getCell(col('Appartement / zone')).value).toBe('A302');
    expect(premiere.getCell(col('Entreprise')).value).toBe('ENT045');
    expect(premiere.getCell(col('Gravité')).value).toBe('Majeure');
    expect(premiere.getCell(col('Statut')).value).toBe('En cours');
    expect(premiere.getCell(col('Photos')).value).toBe(2);
    // Coordonnées normalisées, comme l'exemple du § 8.
    expect(premiere.getCell(col('Position X')).value).toBe(0.6235);
    expect(premiere.getCell(col('Position Y')).value).toBe(0.418);
    // De VRAIES dates : sinon le tri classerait « 15/09 » avant « 02/10 ».
    expect(premiere.getCell(col('Date limite')).value).toBeInstanceOf(Date);

    expect(feuille.getRow(3).getCell(col('Gravité')).value).toBe('Critique');
  });

  it('une donnée absente reste une case vide, jamais « undefined »', async () => {
    const feuille = (await lire(await construireExcel(donnees()))).getWorksheet('Réserves');
    const valeurs = ligne(feuille, 3).map(String);
    expect(valeurs.join('|')).not.toMatch(/undefined|null/);
  });

  it('la synthèse reprend les totaux par statut', async () => {
    const feuille = (await lire(await construireExcel(donnees()))).getWorksheet('Synthèse');
    const lignes = [];
    feuille.eachRow((row) => lignes.push(row.values.slice(1)));

    expect(lignes).toContainEqual(['Total des réserves', 2]);
    expect(lignes).toContainEqual(['En cours', 2]);
    expect(lignes).toContainEqual(['Majeure', 1]);
    expect(lignes).toContainEqual(['Critique', 1]);
  });

  it('l’historique n’a sa feuille que si la section est activée', async () => {
    const sans = await lire(await construireExcel(donnees()));
    expect(sans.getWorksheet('Historique')).toBeUndefined();

    const avec = await lire(await construireExcel(donnees({
      sections: { ...R.SECTIONS_PAR_DEFAUT, history: true },
    })));
    const feuille = avec.getWorksheet('Historique');
    expect(ligne(feuille, 1)).toEqual(['N° de réserve', 'Observation', 'Date', 'Auteur', 'Action', 'Détail']);
    expect(ligne(feuille, 2)[3]).toBe('Awa Diop');
  });

  it('un rapport sans réserve reste un classeur valide', async () => {
    const classeur = await lire(await construireExcel(donnees({ reserves: [] })));
    expect(classeur.getWorksheet('Réserves').rowCount).toBe(1);
  });
});
