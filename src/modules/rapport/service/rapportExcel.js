'use strict';

const ExcelJS = require('exceljs');
const R = require('./rapportReferentiel.js');

/**
 * Export Excel du rapport — format XLSX du § 4, vérifié par le § 23
 * (« Excel : colonnes et données correctes »).
 *
 * ── Ce que l'Excel ajoute au PDF ───────────────────────────────────────────
 *
 * Le PDF est le document qu'on envoie ; l'Excel est celui qu'on TRAVAILLE.
 * Une conductrice de travaux y filtre par entreprise, trie par date limite,
 * colle une colonne « fait le » et le renvoie. C'est pourquoi la feuille des
 * réserves ne contient QUE des données — pas de titre fusionné, pas de ligne
 * décorative — et que le filtre automatique porte sur la ligne d'en-tête.
 *
 * Les mêmes données que le PDF, issues du même objet : deux comptages séparés
 * finiraient toujours par diverger, et un Excel qui contredit son PDF détruit
 * la confiance dans les deux.
 */

const ENTETE = { fond: 'FFF2600C', texte: 'FFFFFFFF' };

/** Valeur affichable — une cellule vide se lit comme un oubli. */
const val = (v, defaut = '') => {
  if (v === null || v === undefined) return defaut;
  const s = typeof v === 'string' ? v.trim() : v;
  return s === '' ? defaut : s;
};

/** Date au format Excel — un vrai objet Date, pour que le tri fonctionne. */
const dateExcel = (v) => {
  if (!v) return null;
  const date = v instanceof Date ? v : new Date(v);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Met en forme une ligne d'en-tête. */
function styliserEntete(feuille, ligne = 1) {
  const entete = feuille.getRow(ligne);
  entete.font = { bold: true, color: { argb: ENTETE.texte }, size: 10 };
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ENTETE.fond } };
  entete.alignment = { vertical: 'middle', horizontal: 'left' };
  entete.height = 20;
}

/** Feuille « Synthèse » — l'identité du rapport et les totaux du § 6. */
function feuilleSynthese(classeur, d) {
  const feuille = classeur.addWorksheet('Synthèse');
  feuille.columns = [
    { key: 'element', width: 34 },
    { key: 'valeur', width: 58 },
  ];

  const bloc = (titre, lignes) => {
    const ligne = feuille.addRow({ element: titre.toUpperCase(), valeur: '' });
    ligne.font = { bold: true, color: { argb: 'FFC94E09' }, size: 10 };
    for (const [element, valeur] of lignes) feuille.addRow({ element, valeur });
    feuille.addRow({});
  };

  bloc('Rapport', [
    ['Nom', val(d.titre)],
    ['Modèle', val(d.modeleLibelle)],
    ['Version', val(d.version, 1)],
    ['Généré le', dateExcel(d.dateRapport)],
    ['Généré par', val(d.auteur)],
  ]);

  bloc('Projet', [
    ['Chantier', val(d.chantier?.nom)],
    ['Référence', val(d.chantier?.code)],
    ['Adresse', val(d.chantier?.adresse)],
    ['Organisation', val(d.organisation?.nom)],
  ]);

  bloc('Périmètre', [
    ['Bâtiment / zone', val(d.perimetre?.localisation, 'Tout le chantier')],
    ['Entreprises', val(d.perimetre?.entreprises, 'Toutes')],
    ['Corps d’état', val(d.perimetre?.corpsEtat, 'Tous')],
    ['Statuts', val(d.perimetre?.statuts, 'Tous')],
    ['Gravités', val(d.perimetre?.gravites, 'Toutes')],
    ['Période', val(d.perimetre?.periode, 'Depuis l’ouverture du chantier')],
  ]);

  const s = d.synthese;
  bloc('Réserves', [
    ['Total des réserves', s.total],
    ...R.CODES_STATUT_RAPPORT.map((code) => [R.libelleStatutRapport(code), s.parStatut[code] || 0]),
  ]);

  bloc('Répartition par gravité', [
    ...R.CODES_GRAVITE.map((code) => [R.libelleGravite(code), s.parGravite[code] || 0]),
    ...(s.graviteNonRenseignee ? [['Non renseignée', s.graviteNonRenseignee]] : []),
  ]);

  if (s.parEntreprise.length) {
    bloc('Répartition par entreprise', s.parEntreprise.map((e) => [e.entreprise, e.total]));
  }

  return feuille;
}

/**
 * Feuille « Réserves » — une ligne par réserve, les colonnes du § 6 plus la
 * localisation normalisée du § 7.
 */
function feuilleReserves(classeur, d) {
  const feuille = classeur.addWorksheet('Réserves');
  feuille.columns = [
    { header: 'N°', key: 'numero', width: 12 },
    { header: 'Bâtiment', key: 'batiment', width: 16 },
    { header: 'Étage', key: 'etage', width: 14 },
    { header: 'Appartement / zone', key: 'zone', width: 18 },
    { header: 'Observation', key: 'titre', width: 34 },
    { header: 'Description', key: 'description', width: 46 },
    { header: 'Entreprise', key: 'entreprise', width: 22 },
    { header: 'Corps d’état', key: 'corpsEtat', width: 18 },
    { header: 'Lot', key: 'lot', width: 16 },
    { header: 'Gravité', key: 'gravite', width: 12 },
    { header: 'Statut', key: 'statut', width: 14 },
    { header: 'Statut détaillé', key: 'statutDetail', width: 16 },
    { header: 'Date de création', key: 'dateCreation', width: 16 },
    { header: 'Date limite', key: 'dateLimite', width: 14 },
    { header: 'Date de correction', key: 'dateCorrection', width: 17 },
    { header: 'Date de validation', key: 'dateValidation', width: 17 },
    { header: 'Plan', key: 'plan', width: 24 },
    { header: 'Page du plan', key: 'planPage', width: 12 },
    { header: 'Position X', key: 'x', width: 11 },
    { header: 'Position Y', key: 'y', width: 11 },
    { header: 'Photos', key: 'photos', width: 9 },
  ];

  for (const r of d.reserves) {
    feuille.addRow({
      numero: val(r.numero),
      batiment: val(r.batiment),
      etage: val(r.etage),
      zone: val(r.zone),
      titre: val(r.titre),
      description: val(r.description),
      entreprise: val(r.entreprise),
      corpsEtat: val(r.corpsEtat),
      lot: val(r.lot),
      gravite: val(r.graviteLibelle),
      statut: val(r.statutRapportLibelle),
      statutDetail: val(r.statutDetail),
      dateCreation: dateExcel(r.dateCreation),
      dateLimite: dateExcel(r.dateLimite),
      dateCorrection: dateExcel(r.dateCorrection),
      dateValidation: dateExcel(r.dateValidation),
      plan: val(r.plan?.nom),
      planPage: r.plan?.page ?? '',
      // Coordonnées NORMALISÉES (0-1), comme dans l'exemple du § 8 :
      // 0.6235 / 0.4180. Elles restent exploitables par un autre outil.
      x: typeof r.plan?.x === 'number' ? Number(r.plan.x.toFixed(4)) : '',
      y: typeof r.plan?.y === 'number' ? Number(r.plan.y.toFixed(4)) : '',
      photos: (r.photos?.length ?? 0),
    });
  }

  styliserEntete(feuille);
  feuille.views = [{ state: 'frozen', ySplit: 1 }];
  // Le filtre automatique : c'est ce que la première personne qui ouvre le
  // fichier va chercher.
  if (d.reserves.length) {
    feuille.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: feuille.columns.length } };
  }
  for (const cle of ['dateCreation', 'dateLimite', 'dateCorrection', 'dateValidation']) {
    feuille.getColumn(cle).numFmt = 'dd/mm/yyyy';
  }
  feuille.getColumn('description').alignment = { wrapText: true, vertical: 'top' };

  return feuille;
}

/** Feuille « Historique » — seulement si la section est activée (§ 10). */
function feuilleHistorique(classeur, d) {
  const lignes = [];
  for (const r of d.reserves) {
    for (const h of r.historique || []) {
      lignes.push({
        numero: val(r.numero),
        titre: val(r.titre),
        date: dateExcel(h.date),
        acteur: val(h.acteur),
        action: val(h.action),
        detail: val(h.detail),
      });
    }
  }
  if (!lignes.length) return null;

  const feuille = classeur.addWorksheet('Historique');
  feuille.columns = [
    { header: 'N° de réserve', key: 'numero', width: 14 },
    { header: 'Observation', key: 'titre', width: 32 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Auteur', key: 'acteur', width: 24 },
    { header: 'Action', key: 'action', width: 22 },
    { header: 'Détail', key: 'detail', width: 46 },
  ];
  for (const ligne of lignes) feuille.addRow(ligne);
  styliserEntete(feuille);
  feuille.views = [{ state: 'frozen', ySplit: 1 }];
  feuille.getColumn('date').numFmt = 'dd/mm/yyyy hh:mm';
  return feuille;
}

/**
 * Construit le classeur Excel du rapport.
 *
 * @param {object} d — les mêmes données que le PDF
 * @returns {Promise<Buffer>}
 */
async function construireExcel(d) {
  const donnees = {
    reserves: [],
    synthese: { total: 0, parStatut: {}, parGravite: {}, parEntreprise: [], graviteNonRenseignee: 0 },
    dateRapport: new Date(),
    ...d,
  };

  const classeur = new ExcelJS.Workbook();
  classeur.creator = 'Widjila';
  classeur.created = donnees.dateRapport instanceof Date ? donnees.dateRapport : new Date();
  classeur.title = val(donnees.titre, 'Rapport de réserves');

  feuilleSynthese(classeur, donnees);
  feuilleReserves(classeur, donnees);
  if (donnees.sections?.history) feuilleHistorique(classeur, donnees);

  const octets = await classeur.xlsx.writeBuffer();
  return Buffer.from(octets);
}

module.exports = { construireExcel };
