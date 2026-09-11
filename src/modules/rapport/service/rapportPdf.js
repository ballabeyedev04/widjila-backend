'use strict';

const PDFDocument = require('pdfkit');
const R = require('./rapportReferentiel.js');

/**
 * Composition du rapport PDF — cahier des charges « Rapports de réserves »,
 * § 6 (contenu du PDF), § 7 (pastille sur le plan) et § 17 (rapport de levée).
 *
 * Ce module ne connaît RIEN à la base de données : il reçoit un objet déjà
 * assemblé par `rapportDonnees.service.js` et le met en page. Cette séparation
 * permet de retoucher la présentation — la partie qui bouge le plus souvent —
 * sans jamais risquer de fausser un filtre ou un comptage.
 *
 * ── La structure imposée par le § 6 ────────────────────────────────────────
 *
 *   PAGE 1  couverture : logos, nom du projet, bâtiment/zone, période, date
 *   PAGE 2  synthèse   : totaux par statut, par gravité, par entreprise
 *   PAGES…  détail     : une fiche par réserve — n°, localisation,
 *                        observation, entreprise/corps d'état, gravité, dates,
 *                        statut, photos, plan + pastille, historique
 *
 * ── Les plans sont posés en DEUX TEMPS ─────────────────────────────────────
 *
 * pdfkit ne sait dessiner que des images. Or la plupart des plans de chantier
 * sont des PDF, et les rastériser demanderait un moteur de rendu que le
 * serveur n'a pas. La mise en page réserve donc un EMPLACEMENT pour chaque
 * extrait de plan, et `rapportPlans.js` y incruste ensuite la page réelle
 * avec pdf-lib — en vectoriel, donc lisible au zoom. Voir `emplacements` dans
 * la valeur de retour.
 *
 * ── Deux règles tenues d'un bout à l'autre ─────────────────────────────────
 *
 *   1. AUCUNE INVENTION. Une donnée absente s'écrit « Non renseigné », jamais
 *      une valeur plausible. `val()` est le seul point d'entrée pour cela.
 *   2. La numérotation d'origine des réserves est conservée telle quelle : le
 *      PDF n'est qu'une vue, renuméroter romprait le lien avec l'application
 *      et avec les échanges déjà faits avec les entreprises.
 */

/** Palette reprise de l'application — le rapport porte la même identité. */
const C = {
  primary: '#f2600c',
  primaryDark: '#c94e09',
  primary100: '#ffeee3',
  texte: '#0f172a',
  texteSecondaire: '#52606e',
  texteAttenue: '#94a3b8',
  bordure: '#e4e9ef',
  bordureForte: '#cdd6e0',
  fondLigne: '#f7f9fb',
  blanc: '#ffffff',
  succes: '#16a34a',
  danger: '#dc2626',
  avertissement: '#d97706',
  info: '#2563eb',
  neutre: '#64748b',
};

const MARGE = 42;
const LARGEUR_PAGE = 595.28; // A4 en points
const HAUTEUR_PAGE = 841.89;
const LARGEUR_UTILE = LARGEUR_PAGE - MARGE * 2;

/** Hauteur réservée au pied de page — rien ne doit déborder dessus. */
const PIED = 34;

/** Couleurs des cinq statuts du § 4. */
const COULEUR_STATUT_RAPPORT = {
  A_TRAITER: C.danger,
  EN_COURS: C.avertissement,
  A_CONTROLER: C.info,
  LEVEE: C.succes,
  CLOTUREE: C.neutre,
};

/** Couleurs des trois gravités du § 4. */
const COULEUR_GRAVITE = {
  CRITIQUE: C.danger,
  MAJEURE: C.avertissement,
  MINEURE: C.info,
};

/* ══════════════════════════════════════════════════════════════════════════
   Valeurs affichables — la règle « aucune invention »
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Valeur affichable d'une donnée éventuellement absente.
 *
 * Une case vide se lit comme un oubli de mise en page ; un libellé se lit
 * comme une information manquante à la source. Sur un document contradictoire
 * envoyé à une entreprise, la nuance décide de qui doit corriger quoi.
 */
const val = (v, defaut = 'Non renseigné') => {
  if (v === null || v === undefined) return defaut;
  const s = String(v).trim();
  return s.length ? s : defaut;
};

/** Date au format français, sans jamais inventer de valeur. */
const dateFr = (d) => {
  if (!d) return 'Non renseigné';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return 'Non renseigné';
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

/** Date et heure — pour l'historique, où l'ordre des gestes compte. */
const dateHeureFr = (d) => {
  if (!d) return 'Non renseigné';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return 'Non renseigné';
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

/** Libellés hérités — exportés pour les autres modules et pour les tests. */
const LIBELLE_STATUT = R.LIBELLE_STATUT_RESERVE;
const LIBELLE_SEVERITE = R.LIBELLE_SEVERITE;

const COULEUR_STATUT = {
  creee: C.neutre, affectee: C.info, prise_en_charge: C.info, en_cours: C.avertissement,
  corrigee: C.primary, a_verifier: C.avertissement, validee: C.succes, refusee: C.danger,
  rouverte: C.danger, en_retard: C.danger, cloturee: C.neutre,
};

/* ══════════════════════════════════════════════════════════════════════════
   Primitives de mise en page
   ══════════════════════════════════════════════════════════════════════════ */

function manquePlace(doc, hauteur) {
  return doc.y + hauteur > HAUTEUR_PAGE - MARGE - PIED;
}

function assurerPlace(doc, hauteur) {
  if (manquePlace(doc, hauteur)) doc.addPage();
}

/** Bandeau de titre de section — la respiration principale du document. */
function titreSection(doc, texte, { compteur = null } = {}) {
  assurerPlace(doc, 46);
  const y = doc.y;

  doc.rect(MARGE, y, LARGEUR_UTILE, 22).fill(C.primary100);
  doc.rect(MARGE, y, 3, 22).fill(C.primary);

  doc.fillColor(C.primaryDark).font('Helvetica-Bold').fontSize(10.5)
    .text(texte.toUpperCase(), MARGE + 10, y + 6.5, { width: LARGEUR_UTILE - 70, lineBreak: false });

  if (compteur !== null) {
    doc.fillColor(C.primaryDark).font('Helvetica').fontSize(9)
      .text(String(compteur), MARGE, y + 7, { width: LARGEUR_UTILE - 10, align: 'right' });
  }

  doc.y = y + 22;
  doc.moveDown(0.6);
  doc.x = MARGE;
}

/** Petit sous-titre (nom de groupe, de plan, de zone…). */
function sousTitre(doc, texte) {
  assurerPlace(doc, 30);
  doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(9.5)
    .text(texte, MARGE, doc.y, { width: LARGEUR_UTILE });
  doc.moveDown(0.35);
  doc.x = MARGE;
}

/**
 * Tableau à colonnes fixes, avec retour à la ligne et coupure de page.
 *
 * pdfkit ne fournit aucun composant de tableau : tout est calculé ici. La
 * hauteur d'une ligne est MESURÉE avant d'être dessinée (`heightOfString`),
 * sans quoi une cellule longue déborderait sur le pied de page.
 *
 * @param {Array<{titre,cle,largeur,align?,couleur?,gras?}>} colonnes
 *        `largeur` est une PROPORTION (leur somme vaut 1).
 */
function tableau(doc, colonnes, lignes, { taille = 8, zebre = true } = {}) {
  const largeurs = colonnes.map((c) => c.largeur * LARGEUR_UTILE);
  const xDe = (i) => MARGE + largeurs.slice(0, i).reduce((a, b) => a + b, 0);
  const PAD = 5;

  const enTete = () => {
    const y = doc.y;
    doc.rect(MARGE, y, LARGEUR_UTILE, 18).fill(C.fondLigne);
    doc.font('Helvetica-Bold').fontSize(taille - 0.5).fillColor(C.texteSecondaire);
    colonnes.forEach((c, i) => {
      doc.text(c.titre, xDe(i) + PAD, y + 5.5, {
        width: largeurs[i] - PAD * 2, align: c.align || 'left', lineBreak: false,
      });
    });
    doc.y = y + 18;
    doc.moveTo(MARGE, doc.y).lineTo(MARGE + LARGEUR_UTILE, doc.y).lineWidth(0.5).stroke(C.bordureForte);
  };

  assurerPlace(doc, 46);
  enTete();

  lignes.forEach((ligne, index) => {
    doc.font('Helvetica').fontSize(taille);

    const hauteurs = colonnes.map((c, i) =>
      doc.heightOfString(String(ligne[c.cle] ?? ''), { width: largeurs[i] - PAD * 2 })
    );
    const hauteur = Math.max(16, Math.max(...hauteurs) + 9);

    // Coupure de page : l'en-tête est réimprimé, sinon les colonnes de la page
    // suivante n'auraient plus de libellé.
    if (manquePlace(doc, hauteur)) {
      doc.addPage();
      enTete();
    }

    const y = doc.y;
    if (zebre && index % 2 === 1) {
      doc.rect(MARGE, y, LARGEUR_UTILE, hauteur).fill(C.fondLigne);
    }

    colonnes.forEach((c, i) => {
      const couleur = typeof c.couleur === 'function' ? c.couleur(ligne) : (c.couleur || C.texte);
      doc.fillColor(couleur).font(c.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(taille)
        .text(String(ligne[c.cle] ?? ''), xDe(i) + PAD, y + 4.5, {
          width: largeurs[i] - PAD * 2, align: c.align || 'left',
        });
    });

    doc.y = y + hauteur;
    doc.moveTo(MARGE, doc.y).lineTo(MARGE + LARGEUR_UTILE, doc.y).lineWidth(0.3).stroke(C.bordure);
  });

  doc.x = MARGE;
  doc.moveDown(0.8);
}

/** Ligne « libellé / valeur » d'une fiche. */
function ficheLigne(doc, libelle, valeur, { x, largeur }) {
  const y = doc.y;
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
    .text(libelle.toUpperCase(), x, y, { width: largeur, lineBreak: false });
  doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(9)
    .text(valeur, x, y + 9.5, { width: largeur });
  doc.y = Math.max(doc.y, y + 25);
}

/** Pastille colorée — statut, gravité. Renvoie sa largeur. */
function pastille(doc, texte, couleur, x, y) {
  doc.font('Helvetica-Bold').fontSize(7.5);
  const largeur = doc.widthOfString(texte) + 12;
  doc.roundedRect(x, y, largeur, 13, 6.5).fill(couleur);
  doc.fillColor(C.blanc).text(texte, x + 6, y + 3.4, { lineBreak: false });
  return largeur;
}

/** Image dessinée dans un cadre, avec repli explicite si elle est illisible. */
function imageEncadree(doc, buffer, x, y, largeur, hauteur, legende = null) {
  try {
    doc.image(buffer, x, y, { fit: [largeur, hauteur], align: 'center', valign: 'center' });
  } catch {
    // Un format que pdfkit refuse ne doit pas coûter tout le document.
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7)
      .text('Photo illisible', x, y + hauteur / 2 - 4, { width: largeur, align: 'center' });
  }
  doc.roundedRect(x, y, largeur, hauteur, 4).lineWidth(0.6).stroke(C.bordure);
  if (legende) {
    doc.fillColor(C.texteSecondaire).font('Helvetica-Bold').fontSize(7)
      .text(legende.toUpperCase(), x, y + hauteur + 3, { width: largeur, align: 'center' });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   § 6 — Page 1 : couverture
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Couverture, seule sur sa page.
 *
 * Le § 6 en fixe le contenu exact : logo Widjila / client, nom du projet,
 * bâtiment / zone, période, date de génération. Le reste — modèle, version,
 * auteur — tient sur une ligne discrète : c'est ce qui permet, six mois plus
 * tard, de savoir DE QUEL document on parle quand deux versions circulent.
 */
function pageDeGarde(doc, d) {
  doc.rect(0, 0, LARGEUR_PAGE, 150).fill(C.primary);

  // Logos : celui de Widjila à gauche, celui du client à droite. Chacun est
  // dessiné SEULEMENT s'il a pu être chargé — un cadre vide ferait croire à
  // une image cassée.
  if (d.logos?.widjila) {
    try {
      doc.image(d.logos.widjila, MARGE, 30, { fit: [150, 46] });
    } catch { /* logo illisible : le titre suffit */ }
  } else {
    doc.fillColor(C.blanc).font('Helvetica-Bold').fontSize(22)
      .text('WIDJILA', MARGE, 40, { lineBreak: false });
  }

  if (d.logos?.client) {
    try {
      doc.image(d.logos.client, LARGEUR_PAGE - MARGE - 120, 30, { fit: [120, 46], align: 'right' });
    } catch { /* logo client illisible */ }
  } else if (d.organisation?.nom) {
    doc.fillColor('#ffe2d0').font('Helvetica-Bold').fontSize(12)
      .text(val(d.organisation.nom, ''), LARGEUR_PAGE / 2, 46, {
        width: LARGEUR_PAGE / 2 - MARGE, align: 'right', lineBreak: false,
      });
  }

  doc.fillColor(C.blanc).font('Helvetica-Bold').fontSize(24)
    .text(val(d.titre, 'Rapport de réserves'), MARGE, 92, { width: LARGEUR_UTILE });

  doc.fillColor('#ffe2d0').font('Helvetica').fontSize(10)
    .text(val(d.modeleLibelle, ''), MARGE, 124, { width: LARGEUR_UTILE, lineBreak: false });

  doc.y = 190;

  // ── Le bloc d'identification du § 6 ────────────────────────────────────
  const lignes = [
    ['Projet', val(d.chantier?.nom)],
    ['Référence du chantier', val(d.chantier?.code)],
    ['Adresse', val(d.chantier?.adresse)],
    ['Bâtiment / zone', val(d.perimetre?.localisation, 'Tout le chantier')],
    ['Entreprise', val(d.perimetre?.entreprises, 'Toutes les entreprises')],
    ['Corps d’état', val(d.perimetre?.corpsEtat, 'Tous les corps d’état')],
    ['Statuts retenus', val(d.perimetre?.statuts, 'Tous les statuts')],
    ['Gravités retenues', val(d.perimetre?.gravites, 'Toutes les gravités')],
    ['Période', val(d.perimetre?.periode, 'Depuis l’ouverture du chantier')],
    ['Date de génération', dateHeureFr(d.dateRapport)],
  ];

  const colonne = (LARGEUR_UTILE - 20) / 2;
  const yDepart = doc.y;
  const moitie = Math.ceil(lignes.length / 2);

  for (const [libelle, valeur] of lignes.slice(0, moitie)) {
    ficheLigne(doc, libelle, valeur, { x: MARGE, largeur: colonne });
  }
  const yGauche = doc.y;

  doc.y = yDepart;
  for (const [libelle, valeur] of lignes.slice(moitie)) {
    ficheLigne(doc, libelle, valeur, { x: MARGE + colonne + 20, largeur: colonne });
  }

  doc.y = Math.max(yGauche, doc.y) + 16;
  doc.x = MARGE;

  // Bandeau de comptage : le chiffre que tout le monde cherche en premier.
  const yBandeau = doc.y;
  doc.roundedRect(MARGE, yBandeau, LARGEUR_UTILE, 54, 8).fillAndStroke(C.primary100, C.bordure);
  doc.fillColor(C.primaryDark).font('Helvetica-Bold').fontSize(22)
    .text(String(d.synthese?.total ?? 0), MARGE, yBandeau + 10, { width: LARGEUR_UTILE, align: 'center' });
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(8.5)
    .text('réserve(s) dans le périmètre de ce rapport', MARGE, yBandeau + 36, {
      width: LARGEUR_UTILE, align: 'center',
    });

  doc.y = yBandeau + 70;

  // Pied de couverture — identité du document.
  //
  // Écrit SOUS la marge basse : la marge est neutralisée le temps de l'écrire.
  // Sans cela, pdfkit juge que le texte déborde et ouvre une page — la
  // couverture s'étalait alors sur deux pages, la seconde ne portant que la
  // ligne « WIDJILA — Traçabilité et transparence ».
  const margeBasse = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const yPied = HAUTEUR_PAGE - MARGE - 70;
  doc.moveTo(MARGE, yPied).lineTo(MARGE + LARGEUR_UTILE, yPied).lineWidth(0.5).stroke(C.bordure);
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(8)
    .text(
      `Rapport ${val(d.reference, '')} · version ${val(d.version, '1')} · généré par ${val(d.auteur)}`,
      MARGE, yPied + 10, { width: LARGEUR_UTILE },
    );
  doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7.5)
    .text(
      'Document figé : il reflète les données du chantier au moment de sa génération et ne se met pas à jour ensuite.',
      MARGE, yPied + 24, { width: LARGEUR_UTILE },
    );
  doc.fillColor(C.primary).font('Helvetica-Bold').fontSize(8)
    .text('WIDJILA — Traçabilité et transparence', MARGE, yPied + 44, { width: LARGEUR_UTILE });
  doc.page.margins.bottom = margeBasse;
}

/* ══════════════════════════════════════════════════════════════════════════
   § 6 — Page 2 : synthèse
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Synthèse : totaux par statut, répartition par gravité, répartition par
 * entreprise — exactement les huit lignes énumérées par le § 6.
 *
 * Les six cartes suivent l'ordre du document (Total, À traiter, En cours, À
 * contrôler, Levées, Clôturées) : c'est l'ordre du cycle de vie d'une
 * réserve, celui dans lequel on lit un tableau de bord de chantier.
 */
function sectionSynthese(doc, d) {
  doc.addPage();
  titreSection(doc, 'Synthèse');

  const s = d.synthese;
  const carte = (libelle, valeur, couleur, x, y, largeur) => {
    doc.roundedRect(x, y, largeur, 46, 6).lineWidth(0.8).fillAndStroke(C.blanc, C.bordure);
    doc.rect(x, y, largeur, 3).fill(couleur);
    doc.fillColor(couleur).font('Helvetica-Bold').fontSize(17)
      .text(String(valeur), x, y + 11, { width: largeur, align: 'center' });
    doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
      .text(libelle, x, y + 32, { width: largeur, align: 'center' });
  };

  const cartes = [
    ['Total des réserves', s.total, C.texte],
    ['À traiter', s.parStatut.A_TRAITER, COULEUR_STATUT_RAPPORT.A_TRAITER],
    ['En cours', s.parStatut.EN_COURS, COULEUR_STATUT_RAPPORT.EN_COURS],
    ['À contrôler', s.parStatut.A_CONTROLER, COULEUR_STATUT_RAPPORT.A_CONTROLER],
    ['Levées', s.parStatut.LEVEE, COULEUR_STATUT_RAPPORT.LEVEE],
    ['Clôturées', s.parStatut.CLOTUREE, COULEUR_STATUT_RAPPORT.CLOTUREE],
  ];

  assurerPlace(doc, 110);
  const largeurCarte = (LARGEUR_UTILE - 16) / 3;
  let y = doc.y;
  cartes.forEach(([libelle, valeur, couleur], index) => {
    const colonne = index % 3;
    if (index === 3) y += 54;
    carte(libelle, valeur ?? 0, couleur, MARGE + colonne * (largeurCarte + 8), y, largeurCarte);
  });
  doc.y = y + 46;
  doc.moveDown(1);
  doc.x = MARGE;

  // ── Répartition par gravité ────────────────────────────────────────────
  sousTitre(doc, 'Répartition par gravité');
  const lignesGravite = R.CODES_GRAVITE.map((code) => ({
    gravite: R.libelleGravite(code),
    total: s.parGravite[code] || 0,
    part: s.total ? `${Math.round(((s.parGravite[code] || 0) / s.total) * 100)} %` : '0 %',
    code,
  }));
  if (s.graviteNonRenseignee) {
    // Comptée à part plutôt que rangée d'office en « mineure » : décider à la
    // place de celui qui a créé la réserve serait une invention.
    lignesGravite.push({
      gravite: 'Non renseignée',
      total: s.graviteNonRenseignee,
      part: s.total ? `${Math.round((s.graviteNonRenseignee / s.total) * 100)} %` : '0 %',
      code: null,
    });
  }
  tableau(doc, [
    {
      titre: 'Gravité', cle: 'gravite', largeur: 0.6, gras: true,
      couleur: (l) => COULEUR_GRAVITE[l.code] || C.texteSecondaire,
    },
    { titre: 'Réserves', cle: 'total', largeur: 0.2, align: 'right' },
    { titre: 'Part', cle: 'part', largeur: 0.2, align: 'right' },
  ], lignesGravite, { zebre: false });

  // ── Répartition par entreprise ─────────────────────────────────────────
  sousTitre(doc, 'Répartition par entreprise');
  if (!s.parEntreprise.length) {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(9)
      .text('Aucune entreprise rattachée aux réserves de ce périmètre.', MARGE, doc.y, { width: LARGEUR_UTILE });
    doc.moveDown(1);
  } else {
    tableau(doc, [
      { titre: 'Entreprise', cle: 'entreprise', largeur: 0.34, gras: true },
      { titre: 'Total', cle: 'total', largeur: 0.11, align: 'right' },
      { titre: 'À traiter', cle: 'A_TRAITER', largeur: 0.12, align: 'right' },
      { titre: 'En cours', cle: 'EN_COURS', largeur: 0.12, align: 'right' },
      { titre: 'À contrôler', cle: 'A_CONTROLER', largeur: 0.13, align: 'right' },
      { titre: 'Levées', cle: 'LEVEE', largeur: 0.09, align: 'right' },
      { titre: 'Clôturées', cle: 'CLOTUREE', largeur: 0.09, align: 'right' },
    ], s.parEntreprise);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   § 6 — Pages suivantes : le détail des réserves
   ══════════════════════════════════════════════════════════════════════════ */

function sectionDetail(doc, d, etat) {
  doc.addPage();
  titreSection(doc, 'Détail des réserves', { compteur: d.reserves.length });

  if (!d.reserves.length) {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(9)
      .text('Aucune réserve ne correspond aux filtres de ce rapport.', MARGE, doc.y, { width: LARGEUR_UTILE });
    doc.moveDown(1);
    return;
  }

  for (const groupe of d.groupes) {
    assurerPlace(doc, 70);
    sousTitre(doc, `${groupe.libelle}  —  ${groupe.reserves.length} réserve(s)`);
    for (const reserve of groupe.reserves) {
      ficheReserve(doc, reserve, d, etat);
    }
    doc.moveDown(0.4);
  }
}

/**
 * Une fiche de réserve — les onze éléments listés par le § 6.
 *
 * Chaque réserve occupe un bloc complet plutôt qu'une ligne de tableau :
 * elle doit porter sa localisation, ses dates, ses photos, son plan et son
 * historique, ce qu'une ligne ne contient pas lisiblement. C'est ce que
 * demande une fiche transmise à une entreprise pour qu'elle intervienne.
 */
function ficheReserve(doc, r, d, etat) {
  const sections = d.sections || {};
  const avecPlan = sections.plans !== false && r.plan;
  const avecHistorique = Boolean(sections.history) && r.historique?.length;
  const estLevee = d.modeleDef?.fiche === 'levee';

  // Hauteur estimée AVANT de commencer : couper une fiche en deux la rend
  // illisible, et c'est le défaut le plus courant de ces documents.
  const hauteurEstimee = 96
    + (r.description ? 30 : 0)
    + (r.photos?.length ? 140 : 0)
    + (avecPlan ? 170 : 0)
    + (avecHistorique ? 60 : 0)
    + (estLevee ? 70 : 0);
  assurerPlace(doc, Math.min(hauteurEstimee, 340));

  const yDebut = doc.y;
  const couleurGravite = COULEUR_GRAVITE[r.gravite] || C.neutre;

  // ── En-tête : n° + observation ─────────────────────────────────────────
  doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(10.5)
    .text(`${val(r.numero, '—')}  ·  ${val(r.titre)}`, MARGE + 10, yDebut + 2, {
      width: LARGEUR_UTILE - 180,
    });

  // Pastilles alignées à droite : statut du § 4, puis gravité.
  let xPastille = MARGE + LARGEUR_UTILE - 8;
  const statutTexte = r.statutRapportLibelle || val(r.statutDetail);
  doc.font('Helvetica-Bold').fontSize(7.5);
  xPastille -= doc.widthOfString(statutTexte) + 12;
  pastille(doc, statutTexte, COULEUR_STATUT_RAPPORT[r.statutRapport] || C.neutre, xPastille, yDebut + 2);

  if (r.graviteLibelle) {
    doc.font('Helvetica-Bold').fontSize(7.5);
    xPastille -= doc.widthOfString(r.graviteLibelle) + 17;
    pastille(doc, r.graviteLibelle, couleurGravite, xPastille, yDebut + 2);
  }

  doc.y = Math.max(doc.y, yDebut + 18);

  // ── Les données obligatoires du § 6, en trois colonnes ─────────────────
  const colonne = (LARGEUR_UTILE - 30) / 3;
  const yMeta = doc.y + 2;
  const colonnes = [
    [
      ['Bâtiment / étage / appart.', val(r.localisation)],
      ['Entreprise', val(r.entreprise)],
    ],
    [
      ['Corps d’état', val(r.corpsEtat)],
      ['Date de création', dateFr(r.dateCreation)],
    ],
    [
      ['Date limite', dateFr(r.dateLimite)],
      ['Statut détaillé', val(r.statutDetail)],
    ],
  ];

  let yMax = yMeta;
  colonnes.forEach((cellules, index) => {
    doc.y = yMeta;
    const x = MARGE + 10 + index * (colonne + 5);
    for (const [libelle, valeur] of cellules) {
      ficheLigne(doc, libelle, valeur, { x, largeur: colonne - 5 });
    }
    yMax = Math.max(yMax, doc.y);
  });
  doc.y = yMax;
  doc.x = MARGE;

  // ── Observation ────────────────────────────────────────────────────────
  if (r.description) {
    doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
      .text('OBSERVATION', MARGE + 10, doc.y, { width: LARGEUR_UTILE - 20 });
    doc.fillColor(C.texte).font('Helvetica').fontSize(8.5)
      .text(String(r.description), MARGE + 10, doc.y + 1, { width: LARGEUR_UTILE - 20 });
    doc.moveDown(0.4);
  }

  // ── Photos (§ 6) ───────────────────────────────────────────────────────
  if (estLevee) blocLevee(doc, r);
  else if (r.photos?.length) blocPhotos(doc, r);

  // ── Plan + pastille (§ 6 et § 7) ───────────────────────────────────────
  if (avecPlan) blocPlan(doc, r, d, etat);

  // ── Historique, si activé (§ 6) ────────────────────────────────────────
  if (avecHistorique) blocHistorique(doc, r);

  // Filet de fin + barre de gravité couvrant tout le bloc.
  const yFin = doc.y + 6;
  doc.rect(MARGE, yDebut, 3, Math.max(10, yFin - yDebut - 4)).fill(couleurGravite);
  doc.moveTo(MARGE, yFin).lineTo(MARGE + LARGEUR_UTILE, yFin).lineWidth(0.4).stroke(C.bordure);

  doc.y = yFin + 8;
  doc.x = MARGE;
}

/** Les photographies d'une réserve — la fiche doit MONTRER le défaut. */
function blocPhotos(doc, r) {
  const hauteur = 108;
  const largeur = (LARGEUR_UTILE - 40) / 3;
  assurerPlace(doc, hauteur + 16);

  const y = doc.y;
  r.photos.slice(0, 3).forEach((photo, index) => {
    imageEncadree(doc, photo.buffer, MARGE + 10 + index * (largeur + 10), y, largeur, hauteur,
      photo.date ? dateFr(photo.date) : null);
  });
  doc.y = y + hauteur + (r.photos.some((p) => p.date) ? 14 : 6);
  doc.x = MARGE;
}

/**
 * § 17 — le rapport de levée.
 *
 * Neuf informations exigées par le cahier des charges : état initial, photo
 * avant, photo après, date de correction, entreprise responsable, personne
 * ayant demandé la levée, personne ayant contrôlé, date de validation,
 * statut final. Chacune est LUE (historique, validateur, dates) ou déclarée
 * « Non renseigné » — aucune n'est déduite d'une autre.
 */
function blocLevee(doc, r) {
  const hauteurPhoto = 120;
  assurerPlace(doc, hauteurPhoto + 70);

  const largeur = (LARGEUR_UTILE - 30) / 2;
  const y = doc.y;

  const cadreVide = (x, texte) => {
    doc.roundedRect(x, y, largeur, hauteurPhoto, 4).lineWidth(0.6).dash(2, { space: 2 }).stroke(C.bordureForte);
    doc.undash();
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(8)
      .text(texte, x, y + hauteurPhoto / 2 - 5, { width: largeur, align: 'center' });
  };

  const avant = r.photosAvant?.[0];
  const apres = r.photosApres?.[0];

  if (avant) imageEncadree(doc, avant.buffer, MARGE + 10, y, largeur, hauteurPhoto, `Avant — ${dateFr(avant.date)}`);
  else cadreVide(MARGE + 10, 'Photo avant : non renseignée');

  const xApres = MARGE + 20 + largeur;
  if (apres) imageEncadree(doc, apres.buffer, xApres, y, largeur, hauteurPhoto, `Après — ${dateFr(apres.date)}`);
  else cadreVide(xApres, 'Photo après : non renseignée');

  doc.y = y + hauteurPhoto + 16;
  doc.x = MARGE;

  const l = r.levee || {};
  tableau(doc, [
    { titre: 'État initial', cle: 'initial', largeur: 0.16 },
    { titre: 'Date de correction', cle: 'correction', largeur: 0.16 },
    { titre: 'Entreprise', cle: 'entreprise', largeur: 0.18 },
    { titre: 'Levée demandée par', cle: 'demandeur', largeur: 0.17 },
    { titre: 'Contrôlée par', cle: 'controleur', largeur: 0.16 },
    { titre: 'Date de validation', cle: 'validation', largeur: 0.17 },
  ], [{
    initial: val(l.statutInitial),
    correction: dateFr(l.dateCorrection),
    entreprise: val(l.entreprise),
    demandeur: val(l.demandeur),
    controleur: val(l.controleur),
    validation: dateFr(l.dateValidation),
  }], { zebre: false, taille: 7.5 });
}

/**
 * § 7 — le plan et la pastille.
 *
 * Deux vues côte à côte : le plan ENTIER, qui situe la réserve dans le
 * bâtiment, et un EXTRAIT zoomé, qui montre la pièce concernée. Le cahier des
 * charges autorise l'un ou l'autre (« sur le plan ou sur un extrait du
 * plan ») ; les deux ensemble évitent l'ambiguïté sur un plan de niveau où
 * quinze logements se ressemblent.
 *
 * Le contenu du plan est incrusté APRÈS coup par `rapportPlans.js` : on ne
 * réserve ici que l'emplacement, avec les coordonnées normalisées.
 */
function blocPlan(doc, r, d, etat) {
  const hauteur = 150;
  assurerPlace(doc, hauteur + 26);

  const plan = d.plans instanceof Map ? d.plans.get(r.plan.id) : null;
  const largeur = (LARGEUR_UTILE - 30) / 2;
  const y = doc.y;
  const positionConnue = r.plan.x !== null && r.plan.y !== null;

  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
    .text(
      `PLAN — ${val(r.plan.nom)} · page ${val(r.plan.page, '1')}`
      + (positionConnue ? ` · position X ${(r.plan.x * 100).toFixed(2)} % / Y ${(r.plan.y * 100).toFixed(2)} %` : ''),
      MARGE + 10, y, { width: LARGEUR_UTILE - 20 },
    );

  const yCadre = doc.y + 2;

  const cadre = (x, legende, mode) => {
    doc.roundedRect(x, yCadre, largeur, hauteur, 4).lineWidth(0.6).stroke(C.bordure);
    doc.fillColor(C.texteSecondaire).font('Helvetica-Bold').fontSize(7)
      .text(legende.toUpperCase(), x, yCadre + hauteur + 3, { width: largeur, align: 'center' });

    if (plan?.image && plan.buffer) {
      // Plan IMAGE : pdfkit sait le dessiner directement, pastille comprise.
      dessinerPlanImage(doc, plan.buffer, x, yCadre, largeur, hauteur, r.plan, mode);
      return;
    }

    if (plan?.buffer) {
      // Plan PDF : l'emplacement est noté, le contenu viendra en seconde passe.
      etat.emplacements.push({
        page: etat.pageCourante,
        planId: r.plan.id,
        pagePlan: r.plan.page || 1,
        x, y: yCadre, largeur, hauteur,
        xNorm: r.plan.x, yNorm: r.plan.y,
        mode,
        reserveId: r.id,
        numero: r.numero,
      });
      return;
    }

    // Aucun aperçu possible (DWG, IFC, fichier absent) : on le DIT, et on
    // donne la position en clair — elle reste exploitable sur le plan papier.
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7.5)
      .text(
        plan ? 'Aperçu indisponible pour ce format de plan' : 'Plan introuvable dans le stockage',
        x + 6, yCadre + hauteur / 2 - 12, { width: largeur - 12, align: 'center' },
      );
    if (positionConnue) {
      doc.fillColor(C.texteSecondaire).font('Helvetica-Bold').fontSize(7.5)
        .text(
          `X ${(r.plan.x * 100).toFixed(2)} %  ·  Y ${(r.plan.y * 100).toFixed(2)} %`,
          x + 6, yCadre + hauteur / 2 + 2, { width: largeur - 12, align: 'center' },
        );
    }
  };

  cadre(MARGE + 10, 'Plan complet', 'complet');
  cadre(MARGE + 20 + largeur, positionConnue ? 'Extrait zoomé' : 'Plan (position inconnue)', 'extrait');

  doc.y = yCadre + hauteur + 14;
  doc.x = MARGE;
}

/**
 * Dessine un plan IMAGE dans un cadre, et pose la pastille dessus.
 *
 * L'image est ajustée en « contain » : le rapport de forme d'un plan n'a
 * aucune raison d'être celui du cadre, et l'étirer déplacerait la pastille
 * par rapport à ce que voit l'utilisateur dans l'application.
 */
function dessinerPlanImage(doc, buffer, x, y, largeur, hauteur, position, mode) {
  try {
    const image = doc.openImage(buffer);
    const echelle = Math.min(largeur / image.width, hauteur / image.height);
    let dessinLargeur = image.width * echelle;
    let dessinHauteur = image.height * echelle;
    let dessinX = x + (largeur - dessinLargeur) / 2;
    let dessinY = y + (hauteur - dessinHauteur) / 2;

    doc.save();
    doc.rect(x, y, largeur, hauteur).clip();

    if (mode === 'extrait' && position.x !== null && position.y !== null) {
      // Extrait : on agrandit ×3 autour du point, en gardant l'image dans le
      // cadre — un zoom qui sortirait du plan montrerait du vide.
      const zoom = 3;
      dessinLargeur *= zoom;
      dessinHauteur *= zoom;
      dessinX = x + largeur / 2 - position.x * dessinLargeur;
      dessinY = y + hauteur / 2 - position.y * dessinHauteur;
      dessinX = Math.min(x, Math.max(x + largeur - dessinLargeur, dessinX));
      dessinY = Math.min(y, Math.max(y + hauteur - dessinHauteur, dessinY));
    }

    doc.image(buffer, dessinX, dessinY, { width: dessinLargeur, height: dessinHauteur });

    if (position.x !== null && position.y !== null) {
      dessinerPastille(doc, dessinX + position.x * dessinLargeur, dessinY + position.y * dessinHauteur);
    }
    doc.restore();
  } catch {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7.5)
      .text('Aperçu du plan illisible', x + 6, y + hauteur / 2 - 4, { width: largeur - 12, align: 'center' });
  }
}

/** La pastille elle-même : un point orange cerclé de blanc, visible partout. */
function dessinerPastille(doc, x, y, rayon = 5) {
  doc.circle(x, y, rayon + 2).lineWidth(1.4).fillAndStroke(C.primary, C.blanc);
  doc.circle(x, y, rayon + 6).lineWidth(0.8).stroke(C.primary);
}

/** Historique d'une réserve — « si activé » (§ 6), sinon jamais imprimé. */
function blocHistorique(doc, r) {
  const lignes = r.historique.slice(-6).map((h) => ({
    date: dateHeureFr(h.date),
    acteur: val(h.acteur, '—'),
    action: val(h.action),
    detail: val(h.detail, '—'),
  }));

  assurerPlace(doc, 40 + lignes.length * 14);
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
    .text('HISTORIQUE', MARGE + 10, doc.y, { width: LARGEUR_UTILE - 20 });
  doc.moveDown(0.2);

  tableau(doc, [
    { titre: 'Date', cle: 'date', largeur: 0.20 },
    { titre: 'Auteur', cle: 'acteur', largeur: 0.22 },
    { titre: 'Action', cle: 'action', largeur: 0.23 },
    { titre: 'Détail', cle: 'detail', largeur: 0.35 },
  ], lignes, { taille: 7.5 });
}

/* ══════════════════════════════════════════════════════════════════════════
   Annexes
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Le PÉRIMÈTRE, en clair, à la fin du document.
 *
 * C'est ce qui rend le rapport opposable : sans lui, deux documents portant
 * le même titre mais produits avec des filtres différents seraient
 * indiscernables, et personne ne saurait lequel fait foi. Il porte aussi ce
 * que le rapport N'A PAS pu inclure — photos illisibles, plans absents —
 * pour que l'absence soit constatée plutôt que subie.
 */
function sectionPerimetre(doc, d) {
  assurerPlace(doc, 160);
  titreSection(doc, 'Périmètre et traçabilité');

  const lignes = [
    { element: 'Chantier', detail: val(d.chantier?.nom) },
    { element: 'Modèle de rapport', detail: val(d.modeleLibelle) },
    { element: 'Bâtiment / zone', detail: val(d.perimetre?.localisation, 'Tout le chantier') },
    { element: 'Entreprises', detail: val(d.perimetre?.entreprises, 'Toutes') },
    { element: 'Corps d’état', detail: val(d.perimetre?.corpsEtat, 'Tous') },
    { element: 'Statuts', detail: val(d.perimetre?.statuts, 'Tous') },
    { element: 'Gravités', detail: val(d.perimetre?.gravites, 'Toutes') },
    { element: 'Période', detail: val(d.perimetre?.periode, 'Depuis l’ouverture du chantier') },
    { element: 'Réserves incluses', detail: String(d.reserves.length) },
    { element: 'Photos incluses', detail: String(d.nbPhotos ?? 0) },
    { element: 'Généré le', detail: dateHeureFr(d.dateRapport) },
    { element: 'Généré par', detail: val(d.auteur) },
    { element: 'Version du rapport', detail: String(val(d.version, '1')) },
  ];

  if (d.nbPhotosIgnorees) {
    lignes.push({
      element: 'Photos non incluses',
      detail: `${d.nbPhotosIgnorees} (illisibles, trop lourdes ou dans un format non imprimable)`,
    });
  }

  tableau(doc, [
    { titre: 'Élément', cle: 'element', largeur: 0.32, gras: true },
    { titre: 'Valeur', cle: 'detail', largeur: 0.68 },
  ], lignes, { zebre: false });
}

/**
 * Cartouche de signatures — modèle OPR / réception uniquement.
 *
 * Un procès-verbal d'opérations préalables à la réception se signe sur place.
 * Sans cet espace, le document imprimé oblige à écrire dans la marge.
 */
function sectionSignatures(doc) {
  assurerPlace(doc, 140);
  titreSection(doc, 'Signatures');

  const largeur = (LARGEUR_UTILE - 20) / 3;
  const y = doc.y + 4;
  ['Maître d’ouvrage', 'Maître d’œuvre', 'Entreprise'].forEach((role, index) => {
    const x = MARGE + index * (largeur + 10);
    doc.roundedRect(x, y, largeur, 92, 6).lineWidth(0.7).stroke(C.bordure);
    doc.fillColor(C.texteSecondaire).font('Helvetica-Bold').fontSize(8)
      .text(role, x + 8, y + 8, { width: largeur - 16 });
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7)
      .text('Nom, date et signature', x + 8, y + 22, { width: largeur - 16 });
  });

  doc.y = y + 104;
  doc.x = MARGE;
}

/**
 * Filigrane de PRÉVISUALISATION (§ 20).
 *
 * Une prévisualisation n'est pas archivée et ne doit pas circuler : sans
 * marque, un PDF ouvert puis transféré deviendrait indiscernable du rapport
 * officiel, alors qu'il n'a ni numéro de version ni trace d'envoi.
 */
function filigrane(doc, texte) {
  const plage = doc.bufferedPageRange();
  for (let i = 0; i < plage.count; i += 1) {
    doc.switchToPage(plage.start + i);
    doc.save();
    doc.rotate(-38, { origin: [LARGEUR_PAGE / 2, HAUTEUR_PAGE / 2] });
    // Taille CALCULÉE pour tenir sur une ligne : à 62 pt, « PRÉVISUALISATION »
    // dépassait la largeur de la page et se coupait en « PRÉVISUALISATIO / N ».
    doc.font('Helvetica-Bold').fontSize(60);
    const taille = Math.min(60, (60 * (LARGEUR_PAGE - 60)) / doc.widthOfString(texte));
    doc.fillColor(C.primary).opacity(0.10).fontSize(taille)
      .text(texte, 0, HAUTEUR_PAGE / 2 - taille / 2, { width: LARGEUR_PAGE, align: 'center', lineBreak: false });
    doc.opacity(1);
    doc.restore();
  }
}

/**
 * Pied de page « Page X / Y » sur toutes les pages sauf la couverture.
 *
 * Fait en SECONDE PASSE : le total n'est connu qu'une fois tout le contenu
 * écrit. `bufferPages: true` autorise ce retour en arrière.
 */
function piedsDePage(doc, d) {
  const plage = doc.bufferedPageRange();
  for (let i = 0; i < plage.count; i += 1) {
    doc.switchToPage(plage.start + i);
    if (i === 0) continue; // la couverture porte son propre pied

    // La marge basse est neutralisée LE TEMPS d'écrire le pied de page : sans
    // cela, pdfkit considère que le texte déborde de la zone utile et ajoute
    // une page — à chaque pied écrit.
    const margeBasse = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = HAUTEUR_PAGE - MARGE + 4;
    doc.moveTo(MARGE, y - 8).lineTo(MARGE + LARGEUR_UTILE, y - 8).lineWidth(0.5).stroke(C.bordure);

    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7.5)
      .text(val(d.chantier?.nom, ''), MARGE, y, { width: LARGEUR_UTILE / 2, lineBreak: false });

    doc.fillColor(C.texteSecondaire).font('Helvetica-Bold').fontSize(7.5)
      .text(`Page ${i + 1} / ${plage.count}`, MARGE, y, { width: LARGEUR_UTILE, align: 'center' });

    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7.5)
      .text(`Rapport du ${dateFr(d.dateRapport)}`, MARGE, y, { width: LARGEUR_UTILE, align: 'right' });

    doc.page.margins.bottom = margeBasse;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Point d'entrée
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Construit le PDF du rapport.
 *
 * @param {object} d — données assemblées par `rapportDonnees.service.js`
 * @returns {Promise<{buffer: Buffer, emplacements: Array}>}
 *   `emplacements` liste les extraits de plan à incruster en seconde passe
 *   (voir l'en-tête de ce fichier et `rapportPlans.js`).
 */
function construireRapport(d) {
  const donnees = {
    reserves: [], groupes: [], sections: R.SECTIONS_PAR_DEFAUT,
    synthese: { total: 0, parStatut: {}, parGravite: {}, parEntreprise: [], graviteNonRenseignee: 0 },
    dateRapport: new Date(),
    ...d,
  };

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGE, bottom: MARGE + PIED, left: MARGE, right: MARGE },
    bufferPages: true, // indispensable au pied de page « Page X / Y »
    info: {
      Title: val(donnees.titre, 'Rapport de réserves'),
      Author: val(donnees.organisation?.nom, 'Widjila'),
      Subject: val(donnees.chantier?.nom, ''),
      Keywords: val(donnees.modeleLibelle, ''),
    },
  });

  // Suivi de la page courante : pdfkit ne l'expose pas, et les emplacements
  // de plan doivent savoir SUR QUELLE PAGE ils ont été réservés.
  const etat = { pageCourante: 0, emplacements: [] };
  doc.on('pageAdded', () => { etat.pageCourante += 1; });

  const morceaux = [];
  doc.on('data', (bloc) => morceaux.push(bloc));
  const termine = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
  });

  pageDeGarde(doc, donnees);
  if (donnees.sections?.summary !== false) sectionSynthese(doc, donnees);
  sectionDetail(doc, donnees, etat);
  if (donnees.modeleDef?.signatures) sectionSignatures(doc);
  sectionPerimetre(doc, donnees);

  if (donnees.previsualisation) filigrane(doc, 'PRÉVISUALISATION');
  piedsDePage(doc, donnees);

  doc.end();
  return termine.then((buffer) => ({ buffer, emplacements: etat.emplacements }));
}

module.exports = {
  construireRapport,
  // Exportés pour les autres modules et pour les tests : ce sont eux qui
  // portent la règle « aucune invention » et les libellés métier.
  val,
  dateFr,
  dateHeureFr,
  LIBELLE_STATUT,
  LIBELLE_SEVERITE,
  COULEUR_STATUT,
  COULEUR_STATUT_RAPPORT,
  COULEUR_GRAVITE,
  MARGE,
  LARGEUR_PAGE,
  HAUTEUR_PAGE,
  LARGEUR_UTILE,
};
