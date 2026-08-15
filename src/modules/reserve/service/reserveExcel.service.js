'use strict';

const ExcelJS = require('exceljs');
const { Reserve, Chantier, Batiment, Etage, Zone, Lot, Organisation } = require('../../../models/index.js');
const ReserveService = require('./reserve.service.js');

/**
 * Formate une date en 'YYYY-MM-DD' sans supposer son type.
 *
 * CAUSE DU BUG CORRIGÉ : le code appelait `r.date_limite.toISOString()`, or
 * `date_limite` est une colonne `DATEONLY`. Sequelize ne l'hydrate PAS en
 * `Date` : il la restitue telle quelle sous forme de chaîne 'YYYY-MM-DD'. Les
 * chaînes n'ont pas de méthode `toISOString` → `TypeError: ... is not a
 * function`, et l'export Excel plantait en 500 dès qu'UNE seule réserve du
 * chantier portait une date limite.
 *
 * On gère donc les deux formes possibles (chaîne ou Date), plus les valeurs
 * vides et les dates invalides, sans présumer laquelle Sequelize renvoie.
 */
function formaterDateOnly(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return '';

  if (valeur instanceof Date) {
    return Number.isNaN(valeur.getTime()) ? '' : valeur.toISOString().slice(0, 10);
  }

  const texte = String(valeur).trim();
  // Cas nominal DATEONLY : déjà 'YYYY-MM-DD' (éventuellement suivi d'une heure).
  const correspondance = texte.match(/^(\d{4}-\d{2}-\d{2})/);
  if (correspondance) return correspondance[1];

  const date = new Date(texte);
  return Number.isNaN(date.getTime()) ? texte : date.toISOString().slice(0, 10);
}

/**
 * Formate un horodatage complet. Même précaution que ci-dessus : `createdAt`
 * est un `DATE` normalement hydraté en objet `Date`, mais une requête `raw`
 * ou un dialecte différent peut renvoyer une chaîne — on ne suppose rien.
 */
function formaterHorodatage(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return '';
  if (valeur instanceof Date) {
    return Number.isNaN(valeur.getTime()) ? '' : valeur.toISOString();
  }
  const date = new Date(String(valeur));
  return Number.isNaN(date.getTime()) ? String(valeur) : date.toISOString();
}

/**
 * Normalise un libellé d'en-tête pour le rendre comparable :
 * suppression des accents, minuscules, espaces/tirets → underscore,
 * suppression de toute autre ponctuation.
 *   "Date limite" / "DATE-LIMITE" / "Date_Limite" → "date_limite"
 *   "Corps d'état"                                → "corps_detat"
 */
function normaliserEntete(valeur) {
  return String(valeur === null || valeur === undefined ? '' : valeur)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // marques diacritiques isolees par NFD
    .toLowerCase()
    .trim()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Alias acceptés pour chaque champ logique (déjà normalisés).
 * La première variante est le nom canonique documenté.
 */
const ALIAS_COLONNES = {
  titre:       ['titre', 'intitule', 'libelle', 'title', 'objet'],
  description: ['description', 'desc', 'commentaire', 'detail', 'details'],
  batiment:    ['batiment', 'bat', 'building'],
  etage:       ['etage', 'niveau', 'floor'],
  zone:        ['zone', 'local', 'piece', 'localisation'],
  lot:         ['lot', 'corps_detat', 'corpsdetat', 'corps_d_etat'],
  severite:    ['severite', 'gravite'],
  priorite:    ['priorite', 'urgence'],
  categorie:   ['categorie', 'type', 'nature'],
  entreprise:  ['entreprise', 'societe', 'sous_traitant'],
  date_limite: ['date_limite', 'datelimite', 'echeance', 'date_echeance', 'delai'],
};

/**
 * Construit la correspondance « champ logique → index NUMÉRIQUE de colonne »
 * en lisant la ligne d'en-tête.
 *
 * CAUSE DU BUG CORRIGÉ : le code appelait `row.getCell('titre')`. ExcelJS
 * n'accepte un nom de colonne dans `getCell()` que si `worksheet.columns` a été
 * défini avec des `key`. Or un classeur chargé via `wb.xlsx.load(buffer)` n'a
 * aucune clé : ExcelJS retombe alors sur l'interprétation « lettre de colonne »
 * et convertit 'titre' en un numéro de colonne astronomique → « Out of bounds.
 * Excel supports columns from 1 to 16384 ». L'import échouait donc à 100 %,
 * quel que soit le fichier.
 *
 * On lit maintenant les en-têtes réels pour obtenir des index numériques, ce
 * qui rend l'import indifférent à l'ORDRE des colonnes, tolérant à la CASSE et
 * aux ACCENTS, et capable de fonctionner avec des colonnes ABSENTES.
 */
function construireIndexColonnes(worksheet, ligneEntete = 1) {
  const trouve = {};
  const row = worksheet.getRow(ligneEntete);
  if (!row) return trouve;

  // includeEmpty:false → on ignore les cellules d'en-tête vides.
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const cle = normaliserEntete(lireTexteCellule(cell));
    if (!cle) return;
    // Variante sans underscore, pour accepter "datelimite" comme "date_limite".
    const cleCompacte = cle.replace(/_/g, '');

    for (const [champ, alias] of Object.entries(ALIAS_COLONNES)) {
      if (trouve[champ]) continue; // 1re colonne correspondante gagne
      if (alias.includes(cle) || alias.includes(cleCompacte)) {
        trouve[champ] = colNumber;
        break;
      }
    }
  });

  return trouve;
}

/**
 * Extrait le texte d'une cellule ExcelJS.
 * `cell.value` n'est pas toujours un scalaire : formule ({ formula, result }),
 * texte enrichi ({ richText: [...] }), lien ({ text, hyperlink }), erreur
 * ({ error }) ou Date. Un `String(value)` naïf rendait "[object Object]".
 */
function lireTexteCellule(cell) {
  if (!cell) return undefined;
  let valeur = cell.value;
  if (valeur === null || valeur === undefined) return undefined;

  if (valeur instanceof Date) {
    return Number.isNaN(valeur.getTime()) ? undefined : valeur.toISOString().slice(0, 10);
  }

  if (typeof valeur === 'object') {
    if (Array.isArray(valeur.richText)) {
      valeur = valeur.richText.map((f) => f.text || '').join('');
    } else if (valeur.error !== undefined) {
      return undefined; // #REF!, #N/A… → cellule considérée vide
    } else if (valeur.text !== undefined) {
      valeur = valeur.text;
    } else if (valeur.result !== undefined) {
      valeur = valeur.result instanceof Date
        ? valeur.result.toISOString().slice(0, 10)
        : valeur.result;
    } else {
      return undefined;
    }
  }

  if (valeur === null || valeur === undefined) return undefined;
  const texte = String(valeur).trim();
  return texte === '' ? undefined : texte;
}

/**
 * Réserves — import/export Excel (module 5 / cahier des charges § Import &
 * export Excel). Export : liste des réserves du chantier (+ récapitulatif).
 * Import : création de réserves depuis un fichier .xlsx.
 */
class ReserveExcelService {

  // -------------------- EXPORT --------------------
  static async exporterExcel(organisationId, chantierId, filtres = {}) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const where = { chantierId };
    if (filtres.statut) where.statut = filtres.statut;
    if (filtres.severite) where.severite = filtres.severite;
    if (filtres.entrepriseId) where.entrepriseId = filtres.entrepriseId;
    if (filtres.batimentId) where.batimentId = filtres.batimentId;

    const reserves = await Reserve.findAll({
      where,
      include: [
        { model: Batiment, as: 'batiment', attributes: ['nom'] },
        { model: Etage, as: 'etage', attributes: ['nom'] },
        { model: Zone, as: 'zone', attributes: ['nom'] },
        { model: Lot, as: 'lot', attributes: ['nom'] },
        { model: Organisation, as: 'entreprise', attributes: ['nom'] },
      ],
      order: [['numero', 'ASC']],
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SuiviChantier API';
    wb.created = new Date();

    // Feuille de détail
    const ws = wb.addWorksheet('Réserves');
    ws.columns = [
      { header: 'Numéro', key: 'numero', width: 12 },
      { header: 'Titre', key: 'titre', width: 40 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Bâtiment', key: 'batiment', width: 18 },
      { header: 'Étage', key: 'etage', width: 12 },
      { header: 'Zone', key: 'zone', width: 18 },
      { header: 'Lot', key: 'lot', width: 18 },
      { header: 'Catégorie', key: 'categorie', width: 16 },
      { header: 'Sévérité', key: 'severite', width: 12 },
      { header: 'Priorité', key: 'priorite', width: 12 },
      { header: 'Statut', key: 'statut', width: 14 },
      { header: 'Entreprise', key: 'entreprise', width: 24 },
      { header: 'Date limite', key: 'date_limite', width: 14 },
      { header: 'Créée le', key: 'createdAt', width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };

    for (const r of reserves) {
      ws.addRow({
        numero: r.numero,
        titre: r.titre,
        description: r.description || '',
        batiment: r.batiment ? r.batiment.nom : '',
        etage: r.etage ? r.etage.nom : '',
        zone: r.zone ? r.zone.nom : '',
        lot: r.lot ? r.lot.nom : '',
        categorie: r.categorie || '',
        severite: r.severite,
        priorite: r.priorite,
        statut: r.statut,
        entreprise: r.entreprise ? r.entreprise.nom : '',
        // `date_limite` est un DATEONLY : Sequelize renvoie une CHAÎNE
        // 'YYYY-MM-DD', pas un objet Date → `.toISOString()` levait
        // « is not a function ». cf. formaterDateOnly() en haut de fichier.
        date_limite: formaterDateOnly(r.date_limite),
        createdAt: formaterHorodatage(r.createdAt),
      });
    }

    // Feuille récapitulative
    const recap = wb.addWorksheet('Récapitulatif');
    recap.addRow(['Réserves — ' + chantier.nom]);
    recap.getRow(1).font = { bold: true };
    recap.addRow(['Total', reserves.length]);
    const parStatut = {};
    for (const r of reserves) parStatut[r.statut] = (parStatut[r.statut] || 0) + 1;
    for (const [statut, n] of Object.entries(parStatut)) recap.addRow([`Statut ${statut}`, n]);

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `reserves-${chantier.code || chantier.id}.xlsx`;

    return { success: true, buffer, filename };
  }

  // -------------------- IMPORT --------------------
  /**
   * Importe des réserves depuis un .xlsx. Colonnes attendues (1re ligne) :
   * titre (obligatoire), description, batiment, etage, zone, lot,
   * severite, priorite, categorie, entreprise, date_limite.
   *
   * Les en-têtes sont reconnus indépendamment de la CASSE, des ACCENTS et de
   * l'ORDRE des colonnes ; les colonnes absentes sont simplement ignorées
   * (cf. normaliserEntete / ALIAS_COLONNES / construireIndexColonnes).
   * Seule la colonne « titre » est obligatoire.
   *
   * Les emplacements (batiment/étage/zone/lot) sont cherchés par nom sur le
   * chantier ; s'ils sont introuvables, la réserve est créée sans emplacement.
   */
  static async importerExcel(organisationId, chantierId, buffer, utilisateurId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    let wb;
    try {
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
    } catch (err) {
      return { success: false, message: 'Fichier Excel illisible : ' + err.message };
    }

    const ws = wb.worksheets[0];
    if (!ws) return { success: false, message: 'Le fichier ne contient aucune feuille' };

    // Le contrôle amont borne la TAILLE du fichier et le taux de décompression
    // déclaré, pas le nombre de lignes réellement traitées — chacune déclenchant
    // un INSERT.
    const MAX_LIGNES_IMPORT_EXCEL = 5000;
    if (ws.rowCount - 1 > MAX_LIGNES_IMPORT_EXCEL) {
      return {
        success: false,
        message: `Fichier trop volumineux : ${ws.rowCount - 1} lignes (maximum ${MAX_LIGNES_IMPORT_EXCEL} par import).`,
      };
    }

    // Correspondance « champ → index numérique de colonne », lue sur la ligne
    // d'en-tête. Indispensable : un classeur chargé depuis un buffer n'a aucune
    // clé de colonne, donc `row.getCell('titre')` était interprété comme une
    // LETTRE de colonne et levait « Out of bounds ».
    const colonnes = construireIndexColonnes(ws, 1);

    if (!colonnes.titre) {
      return {
        success: false,
        message: "Colonne « titre » introuvable : la première ligne du fichier doit contenir les en-têtes "
          + '(titre, description, batiment, etage, zone, lot, severite, priorite, categorie, date_limite).',
      };
    }

    // Pré-chargement des emplacements du chantier (lookup par nom)
    const [batiments, etages, zones, lots] = await Promise.all([
      Batiment.findAll({ where: { chantierId }, attributes: ['id', 'nom'] }),
      Etage.findAll({ include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: [] }], attributes: ['id', 'nom'] }),
      Zone.findAll({ include: [{ model: Etage, as: 'etage', include: [{ model: Batiment, as: 'batiment', where: { chantierId }, attributes: [] }] }], attributes: ['id', 'nom'] }),
      Lot.findAll({ where: { chantierId }, attributes: ['id', 'nom'] }),
    ]);
    const norm = (s) => String(s || '').trim().toLowerCase();

    const results = [];
    let importes = 0;

    const lignes = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // ligne d'en-tête
      lignes.push({ row, rowNumber });
    });

    /**
     * Recherche d'un emplacement par nom. Si la colonne est absente ou la
     * cellule vide, on renvoie null SANS chercher : sinon `norm(undefined)`
     * valait '' et pouvait correspondre à un emplacement au nom vide.
     */
    const chercherId = (liste, valeur) => {
      if (!valeur) return null;
      const cible = norm(valeur);
      const trouve = liste.find((el) => norm(el.nom) === cible);
      return trouve ? trouve.id : null;
    };

    for (const { row, rowNumber } of lignes) {
      // Accès par INDEX numérique issu de l'en-tête (et non par nom, qu'ExcelJS
      // aurait pris pour une lettre de colonne). Colonne absente → undefined.
      const cell = (champ) => {
        const index = colonnes[champ];
        if (!index) return undefined;
        return lireTexteCellule(row.getCell(index));
      };

      const titre = cell('titre');
      if (!titre) {
        results.push({ ligne: rowNumber, statut: 'erreur', erreur: 'titre manquant' });
        continue;
      }

      const batimentId = chercherId(batiments, cell('batiment'));
      const etageId = chercherId(etages, cell('etage'));
      const zoneId = chercherId(zones, cell('zone'));
      const lotId = chercherId(lots, cell('lot'));

      // Valeurs d'énumération : comparées en minuscules/sans accent pour
      // accepter « Haute », « CRITIQUE », « Sévérité » saisis à la main.
      const enumOuDefaut = (champ, valeursAutorisees, defaut) => {
        const brut = cell(champ);
        if (!brut) return defaut;
        const normalise = normaliserEntete(brut);
        return valeursAutorisees.includes(normalise) ? normalise : defaut;
      };
      const NIVEAUX = ['faible', 'moyenne', 'haute', 'critique'];

      const res = await ReserveService.creerReserve(organisationId, {
        chantierId,
        titre,
        description: cell('description') || null,
        batimentId, etageId, zoneId, lotId,
        severite: enumOuDefaut('severite', NIVEAUX, 'moyenne'),
        priorite: enumOuDefaut('priorite', NIVEAUX, 'moyenne'),
        categorie: cell('categorie') || 'autre',
        // Une cellule Excel typée « date » est renvoyée en Date par ExcelJS :
        // lireTexteCellule() l'a déjà ramenée en 'YYYY-MM-DD'.
        date_limite: cell('date_limite') || null,
      }, utilisateurId);

      if (res && res.success) {
        results.push({ ligne: rowNumber, titre, statut: 'importee', numero: res.reserve.numero });
        importes += 1;
      } else {
        results.push({ ligne: rowNumber, titre, statut: 'erreur', erreur: res ? res.message : 'erreur inconnue' });
      }
    }

    return {
      success: true,
      message: `Import terminé : ${importes} réserve(s) importée(s)`,
      results,
    };
  }
}

module.exports = ReserveExcelService;
