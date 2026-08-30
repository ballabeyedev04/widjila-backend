'use strict';

const PDFDocument = require('pdfkit');

/**
 * Construction du rapport de chantier PDF.
 *
 * Ce module ne connaît RIEN à la base de données : il reçoit un objet de
 * données déjà assemblé (voir `rapport.service.js#genererRapport`) et le met
 * en page. Cette séparation permet de retoucher la présentation — la partie
 * qui bouge le plus souvent — sans jamais risquer de casser les requêtes ni
 * l'isolation multi-tenant.
 *
 * ── Structure, conforme au parcours de lecture attendu par les entreprises ──
 *   en-tête projet → participants → entreprises → synthèse → réserves
 *   (groupées par localisation, avec leurs photos) → à traiter → remarques
 *   → points à vérifier → sources
 *
 * ── Deux règles tenues d'un bout à l'autre ─────────────────────────────────
 *   1. AUCUNE INVENTION. Une donnée absente s'écrit « Non renseigné », jamais
 *      une valeur plausible. `val()` est le seul point d'entrée pour ça.
 *   2. La numérotation d'origine des réserves est conservée telle quelle. Le
 *      PDF n'est qu'une vue : renuméroter romprait le lien avec l'application,
 *      le mobile et les échanges déjà faits avec les entreprises.
 */

/**
 * Palette — reprise à l'identique de l'application (`admin/src/index.css` et
 * `mobile/lib/core/theme/app_colors.dart`). Le rapport est un document envoyé
 * aux entreprises : il porte l'identité de l'application, pas une seconde.
 */
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

/**
 * Valeur affichable d'une donnée éventuellement absente.
 *
 * C'est le garde-fou de la règle « aucune invention » : partout où une donnée
 * peut manquer, elle passe par ici et devient un libellé explicite plutôt
 * qu'une case vide — une case vide se lit comme un oubli de mise en page, pas
 * comme une information manquante à la source.
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

/** Libellés lisibles des énumérations métier. */
const LIBELLE_STATUT = {
  creee: 'Créée', affectee: 'Affectée', prise_en_charge: 'Prise en charge',
  en_cours: 'En cours', corrigee: 'Corrigée', a_verifier: 'À vérifier',
  validee: 'Validée', refusee: 'Refusée', rouverte: 'Rouverte',
  en_retard: 'En retard', cloturee: 'Clôturée',
};

const COULEUR_STATUT = {
  creee: C.neutre, affectee: C.info, prise_en_charge: C.info, en_cours: C.avertissement,
  corrigee: C.primary, a_verifier: C.avertissement, validee: C.succes, refusee: C.danger,
  rouverte: C.danger, en_retard: C.danger, cloturee: C.neutre,
};

const LIBELLE_SEVERITE = {
  faible: 'Faible', moyenne: 'Moyenne', haute: 'Haute', critique: 'Critique',
};

const COULEUR_SEVERITE = {
  faible: C.info, moyenne: C.avertissement, haute: C.danger, critique: C.danger,
};

const LIBELLE_ROLE = {
  Admin: 'Administrateur', ChefProjet: 'Chef de projet',
  ConducteurTravaux: 'Conducteur de travaux', BureauControle: 'Bureau de contrôle',
  MaitreOuvrage: "Maître d'ouvrage", MaitreOeuvre: "Maître d'œuvre",
  Entreprise: 'Entreprise', Client: 'Client', Pilote: 'Pilote de chantier',
  SousTraitant: 'Sous-traitant',
};

const LIBELLE_PRESENCE = {
  invite: 'Convoqué', accepte: 'Accepté', decline: 'Décliné',
  present: 'Présent', absent: 'Absent',
};

const LIBELLE_TYPE_PARTENAIRE = {
  client: 'Client', maitre_ouvrage: "Maître d'ouvrage", maitre_oeuvre: "Maître d'œuvre",
  sous_traitant: 'Sous-traitant', fournisseur: 'Fournisseur',
  bureau_controle: 'Bureau de contrôle', autre: 'Autre',
};

/* ══════════════════════════════════════════════════════════════════════════
   Primitives de mise en page
   ══════════════════════════════════════════════════════════════════════════ */

/** Vrai s'il ne reste pas `hauteur` points avant le pied de page. */
function manquePlace(doc, hauteur) {
  return doc.y + hauteur > HAUTEUR_PAGE - MARGE - PIED;
}

/** Passe à la page suivante si le bloc à venir ne tient pas. */
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

/** Petit sous-titre (nom de plan, de zone…). */
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
 * hauteur d'une ligne est mesurée AVANT de la dessiner (`heightOfString`),
 * sans quoi une cellule longue déborderait sur le pied de page ou serait
 * coupée en deux entre deux pages.
 *
 * @param {Array<{titre:string,cle:string,largeur:number,align?:string,couleur?:Function}>} colonnes
 *        `largeur` est une PROPORTION (leur somme vaut 1).
 * @param {Array<object>} lignes
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

    // Hauteur réelle de la ligne = la plus haute de ses cellules.
    const hauteurs = colonnes.map((c, i) =>
      doc.heightOfString(String(ligne[c.cle] ?? ''), { width: largeurs[i] - PAD * 2 })
    );
    const hauteur = Math.max(16, Math.max(...hauteurs) + 9);

    // Coupure de page : on réimprime l'en-tête, sinon les colonnes de la
    // page suivante n'auraient plus de libellé.
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

/** Ligne « libellé : valeur » de la fiche d'en-tête. */
function ficheLigne(doc, libelle, valeur, { x, largeur }) {
  const y = doc.y;
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(8)
    .text(libelle.toUpperCase(), x, y, { width: largeur, lineBreak: false });
  doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(9.5)
    .text(valeur, x, y + 10, { width: largeur });
  doc.y = Math.max(doc.y, y + 26);
}

/** Pastille colorée — statut, sévérité. */
function pastille(doc, texte, couleur, x, y) {
  doc.font('Helvetica-Bold').fontSize(7.5);
  const largeur = doc.widthOfString(texte) + 12;
  doc.roundedRect(x, y, largeur, 13, 6.5).fill(couleur);
  doc.fillColor(C.blanc).text(texte, x + 6, y + 3.4, { lineBreak: false });
  return largeur;
}

/* ══════════════════════════════════════════════════════════════════════════
   Sections
   ══════════════════════════════════════════════════════════════════════════ */

/** En-tête de la première page — identité du rapport et du projet. */
function pageDeGarde(doc, d) {
  doc.rect(0, 0, LARGEUR_PAGE, 96).fill(C.primary);

  doc.fillColor(C.blanc).font('Helvetica-Bold').fontSize(19)
    .text(val(d.titre, 'Rapport de chantier'), MARGE, 26, { width: LARGEUR_UTILE - 150 });

  doc.font('Helvetica').fontSize(9.5).fillColor('#ffe2d0')
    .text(val(d.organisation?.nom, ''), MARGE, 54, { width: LARGEUR_UTILE - 150 });

  // Bloc de droite : référence et date, comme sur un en-tête de compte rendu.
  doc.font('Helvetica').fontSize(8).fillColor('#ffe2d0')
    .text('RAPPORT DU', MARGE, 26, { width: LARGEUR_UTILE, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.blanc)
    .text(dateFr(d.dateRapport), MARGE, 37, { width: LARGEUR_UTILE, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#ffe2d0')
    .text(`Réf. ${val(d.reference)}`, MARGE, 55, { width: LARGEUR_UTILE, align: 'right' });

  doc.y = 116;

  titreSection(doc, 'Informations sur le projet');

  const colonne = (LARGEUR_UTILE - 16) / 2;
  const yDepart = doc.y;

  ficheLigne(doc, 'Nom du projet', val(d.chantier?.nom), { x: MARGE, largeur: colonne });
  ficheLigne(doc, 'Adresse', val(d.chantier?.adresse), { x: MARGE, largeur: colonne });
  ficheLigne(doc, 'Type de rapport', val(d.typeLibelle), { x: MARGE, largeur: colonne });
  const yGauche = doc.y;

  doc.y = yDepart;
  const xDroite = MARGE + colonne + 16;
  ficheLigne(doc, 'Référence du chantier', val(d.chantier?.code), { x: xDroite, largeur: colonne });
  ficheLigne(doc, 'Statut du chantier', val(d.chantier?.statut), { x: xDroite, largeur: colonne });
  ficheLigne(doc, 'Période', `${dateFr(d.chantier?.date_debut)} → ${dateFr(d.chantier?.date_fin)}`, { x: xDroite, largeur: colonne });

  doc.y = Math.max(yGauche, doc.y);
  doc.moveDown(0.6);
  doc.x = MARGE;
}

/** Participants — membres affectés au chantier, avec leur présence si connue. */
function sectionParticipants(doc, d) {
  titreSection(doc, 'Participants', { compteur: d.participants.length });

  if (!d.participants.length) {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(9)
      .text('Aucun participant enregistré pour ce chantier.', MARGE, doc.y, { width: LARGEUR_UTILE });
    doc.moveDown(1);
    return;
  }

  tableau(doc, [
    { titre: 'Nom', cle: 'nom', largeur: 0.22, gras: true },
    { titre: 'Rôle', cle: 'role', largeur: 0.18 },
    { titre: 'Fonction', cle: 'fonction', largeur: 0.18 },
    { titre: 'Email', cle: 'email', largeur: 0.24 },
    { titre: 'Téléphone', cle: 'telephone', largeur: 0.11 },
    { titre: 'Présence', cle: 'presence', largeur: 0.07, align: 'center' },
  ], d.participants);
}

/** Entreprises — lots numérotés et partenaires, comme sur un compte rendu. */
function sectionEntreprises(doc, d) {
  titreSection(doc, 'Entreprises et intervenants', { compteur: d.entreprises.length });

  if (!d.entreprises.length) {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(9)
      .text('Aucune entreprise enregistrée pour ce chantier.', MARGE, doc.y, { width: LARGEUR_UTILE });
    doc.moveDown(1);
    return;
  }

  tableau(doc, [
    { titre: 'Lot', cle: 'lot', largeur: 0.17, gras: true },
    { titre: 'Entreprise', cle: 'entreprise', largeur: 0.20 },
    { titre: 'Contact', cle: 'contact', largeur: 0.15 },
    { titre: 'Adresse', cle: 'adresse', largeur: 0.20 },
    { titre: 'Email', cle: 'email', largeur: 0.18 },
    { titre: 'Téléphone', cle: 'telephone', largeur: 0.10 },
  ], d.entreprises);
}

/** Synthèse chiffrée — statuts, sévérités, phases. */
function sectionSynthese(doc, d) {
  titreSection(doc, 'Synthèse');

  const total = d.reserves.length;
  const carte = (libelle, valeur, couleur, x, largeur) => {
    const y = doc.y;
    doc.roundedRect(x, y, largeur, 40, 6).lineWidth(0.8).fillAndStroke(C.blanc, C.bordure);
    doc.fillColor(couleur).font('Helvetica-Bold').fontSize(16)
      .text(String(valeur), x, y + 7, { width: largeur, align: 'center' });
    doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
      .text(libelle, x, y + 26, { width: largeur, align: 'center' });
  };

  assurerPlace(doc, 52);
  const yCartes = doc.y;
  const largeurCarte = (LARGEUR_UTILE - 24) / 4;
  const compte = (predicat) => d.reserves.filter(predicat).length;

  carte('Réserves', total, C.texte, MARGE, largeurCarte);
  carte('Levées', compte((r) => ['validee', 'cloturee'].includes(r.statut)), C.succes, MARGE + (largeurCarte + 8), largeurCarte);
  carte('En cours', compte((r) => ['affectee', 'prise_en_charge', 'en_cours', 'corrigee', 'a_verifier'].includes(r.statut)), C.avertissement, MARGE + (largeurCarte + 8) * 2, largeurCarte);
  carte('En retard', compte((r) => r.statut === 'en_retard'), C.danger, MARGE + (largeurCarte + 8) * 3, largeurCarte);

  doc.y = yCartes + 40;
  doc.moveDown(0.9);
  doc.x = MARGE;

  // Répartition par phase — l'axe de lecture demandé pour l'historique.
  if (d.repartitionPhases.length) {
    sousTitre(doc, 'Répartition par phase');
    tableau(doc, [
      { titre: 'Phase', cle: 'phase', largeur: 0.7, gras: true },
      { titre: 'Réserves', cle: 'total', largeur: 0.3, align: 'right' },
    ], d.repartitionPhases, { zebre: false });
  }
}

/**
 * Réserves, groupées par localisation puis détaillées.
 *
 * Chaque réserve occupe un bloc complet plutôt qu'une ligne de tableau : elle
 * doit porter sa description, sa localisation, ses dates ET ses photos, ce
 * qu'une ligne ne peut pas contenir lisiblement. C'est ce que demande une
 * fiche transmise à une entreprise.
 */
function sectionReserves(doc, d) {
  doc.addPage();
  titreSection(doc, 'Réserves et observations', { compteur: d.reserves.length });

  if (!d.reserves.length) {
    doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(9)
      .text('Aucune réserve dans le périmètre retenu.', MARGE, doc.y, { width: LARGEUR_UTILE });
    return;
  }

  for (const groupe of d.groupes) {
    assurerPlace(doc, 60);
    sousTitre(doc, `${groupe.libelle}  —  ${groupe.reserves.length} réserve(s)`);

    for (const r of groupe.reserves) {
      blocReserve(doc, r);
    }
    doc.moveDown(0.5);
  }
}

/** Une réserve : en-tête coloré, métadonnées, description, photos. */
function blocReserve(doc, r) {
  const photos = r.photos || [];
  // Hauteur estimée pour décider d'une coupure de page AVANT de commencer :
  // couper un bloc de réserve en deux le rendrait illisible.
  const hauteurEstimee = 64
    + (r.description ? 26 : 0)
    + (photos.length ? 92 : 0);
  assurerPlace(doc, Math.min(hauteurEstimee, 300));

  const yDebut = doc.y;

  // Barre latérale à la couleur de la sévérité — repère visuel immédiat.
  const couleurSeverite = COULEUR_SEVERITE[r.severite] || C.neutre;

  doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(10)
    .text(`${val(r.numero, '—')}  ·  ${val(r.titre)}`, MARGE + 10, yDebut + 2, {
      width: LARGEUR_UTILE - 150,
    });

  // Pastilles alignées à droite de la première ligne.
  let xPastille = MARGE + LARGEUR_UTILE - 8;
  const statutTexte = LIBELLE_STATUT[r.statut] || val(r.statut);
  doc.font('Helvetica-Bold').fontSize(7.5);
  const lStatut = doc.widthOfString(statutTexte) + 12;
  xPastille -= lStatut;
  pastille(doc, statutTexte, COULEUR_STATUT[r.statut] || C.neutre, xPastille, yDebut + 2);

  const severiteTexte = LIBELLE_SEVERITE[r.severite] || val(r.severite, '');
  if (severiteTexte && severiteTexte !== 'Non renseigné') {
    doc.font('Helvetica-Bold').fontSize(7.5);
    const lSev = doc.widthOfString(severiteTexte) + 12;
    xPastille -= lSev + 5;
    pastille(doc, severiteTexte, couleurSeverite, xPastille, yDebut + 2);
  }

  doc.y = Math.max(doc.y, yDebut + 16);

  // Ligne de métadonnées — tout ce qui situe et engage la réserve.
  const meta = [
    `Localisation : ${val(r.localisation)}`,
    `Lot : ${val(r.lot)}`,
    `Entreprise : ${val(r.entreprise)}`,
    `Phase : ${val(r.phase)}`,
    `Créée le : ${dateFr(r.createdAt)}`,
    `Pour le : ${dateFr(r.date_limite)}`,
    `Levée le : ${dateFr(r.date_validation)}`,
  ].join('   •   ');

  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(7.5)
    .text(meta, MARGE + 10, doc.y, { width: LARGEUR_UTILE - 20 });

  if (r.description) {
    doc.moveDown(0.25);
    doc.fillColor(C.texte).font('Helvetica').fontSize(8.5)
      .text(r.description, MARGE + 10, doc.y, { width: LARGEUR_UTILE - 20 });
  }

  // Photos : la fiche doit MONTRER le défaut, pas seulement signaler qu'une
  // photo existe.
  if (photos.length) {
    doc.moveDown(0.4);
    const hauteurPhoto = 78;
    assurerPlace(doc, hauteurPhoto + 8);
    let x = MARGE + 10;
    const yPhoto = doc.y;

    for (const photo of photos) {
      const largeurMax = 104;
      if (x + largeurMax > MARGE + LARGEUR_UTILE) break; // une seule rangée
      try {
        doc.image(photo, x, yPhoto, { fit: [largeurMax, hauteurPhoto], align: 'center' });
        doc.roundedRect(x, yPhoto, largeurMax, hauteurPhoto, 4).lineWidth(0.6).stroke(C.bordure);
      } catch {
        // Image illisible ou format non supporté par pdfkit : on ne fait pas
        // échouer tout le rapport pour une vignette.
        doc.roundedRect(x, yPhoto, largeurMax, hauteurPhoto, 4).lineWidth(0.6).stroke(C.bordure);
        doc.fillColor(C.texteAttenue).font('Helvetica').fontSize(7)
          .text('Photo illisible', x, yPhoto + hauteurPhoto / 2 - 4, { width: largeurMax, align: 'center' });
      }
      x += largeurMax + 8;
    }
    doc.y = yPhoto + hauteurPhoto;
  }

  // Filet de séparation + barre de sévérité couvrant tout le bloc.
  const yFin = doc.y + 6;
  doc.rect(MARGE, yDebut, 3, yFin - yDebut - 4).fill(couleurSeverite);
  doc.moveTo(MARGE, yFin).lineTo(MARGE + LARGEUR_UTILE, yFin).lineWidth(0.4).stroke(C.bordure);

  doc.y = yFin + 7;
  doc.x = MARGE;
}

/** Réserves restant à traiter — la liste d'actions, tirée des données. */
function sectionATraiter(doc, d) {
  if (!d.aTraiter.length) return;

  titreSection(doc, 'Réserves à traiter', { compteur: d.aTraiter.length });
  doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(8)
    .text('Réserves non levées à la date de génération, classées par échéance.', MARGE, doc.y, { width: LARGEUR_UTILE });
  doc.moveDown(0.5);

  tableau(doc, [
    { titre: 'N°', cle: 'numero', largeur: 0.09, gras: true },
    { titre: 'Réserve', cle: 'titre', largeur: 0.31 },
    { titre: 'Localisation', cle: 'localisation', largeur: 0.18 },
    { titre: 'Entreprise', cle: 'entreprise', largeur: 0.18 },
    { titre: 'Pour le', cle: 'echeance', largeur: 0.12, align: 'center' },
    {
      titre: 'Statut', cle: 'statutLibelle', largeur: 0.12, align: 'center',
      couleur: (l) => COULEUR_STATUT[l.statut] || C.neutre,
    },
  ], d.aTraiter);
}

/** Remarques générales — comptes rendus d'inspection. */
function sectionRemarques(doc, d) {
  if (!d.remarques.length) return;

  titreSection(doc, 'Remarques générales', { compteur: d.remarques.length });

  for (const remarque of d.remarques) {
    assurerPlace(doc, 44);
    doc.fillColor(C.texte).font('Helvetica-Bold').fontSize(9)
      .text(remarque.titre, MARGE, doc.y, { width: LARGEUR_UTILE });
    doc.fillColor(C.texteSecondaire).font('Helvetica').fontSize(8.5)
      .text(remarque.texte, MARGE, doc.y + 2, { width: LARGEUR_UTILE });
    doc.moveDown(0.6);
  }
}

/**
 * Points à vérifier — données manquantes ou incohérentes CONSTATÉES.
 *
 * Rien n'est deviné ici : chaque point est le résultat d'un comptage sur les
 * données du rapport. C'est ce qui permet à l'entreprise de savoir ce qui
 * reste à compléter avant diffusion.
 */
function sectionPointsAVerifier(doc, d) {
  if (!d.pointsAVerifier.length) return;

  titreSection(doc, 'Points nécessitant une vérification', { compteur: d.pointsAVerifier.length });

  d.pointsAVerifier.forEach((point, i) => {
    assurerPlace(doc, 24);
    const y = doc.y;
    doc.circle(MARGE + 5, y + 5, 2.4).fill(C.avertissement);
    doc.fillColor(C.texte).font('Helvetica').fontSize(8.5)
      .text(`${i + 1}. ${point}`, MARGE + 14, y, { width: LARGEUR_UTILE - 14 });
    doc.moveDown(0.35);
  });
  doc.moveDown(0.5);
}

/** Sources — traçabilité de ce qui a alimenté le rapport. */
function sectionSources(doc, d) {
  titreSection(doc, 'Sources et périmètre');

  const lignes = [
    { element: 'Chantier', detail: val(d.chantier?.nom) },
    { element: 'Périmètre des réserves', detail: val(d.perimetre) },
    { element: 'Généré le', detail: dateFr(d.dateRapport) },
    { element: 'Généré par', detail: val(d.auteur) },
    { element: 'Réserves incluses', detail: String(d.reserves.length) },
    { element: 'Photos incluses', detail: String(d.nbPhotos) },
  ];

  tableau(doc, [
    { titre: 'Élément', cle: 'element', largeur: 0.35, gras: true },
    { titre: 'Valeur', cle: 'detail', largeur: 0.65 },
  ], lignes, { zebre: false });
}

/**
 * Pied de page « Page X / Y » sur toutes les pages.
 *
 * Fait en SECONDE PASSE : le total de pages n'est connu qu'une fois tout le
 * contenu écrit. `bufferPages: true` autorise ce retour en arrière — sans
 * lui, pdfkit a déjà envoyé les pages et « / Y » resterait inconnu.
 */
function piedsDePage(doc, d) {
  const plage = doc.bufferedPageRange();
  for (let i = 0; i < plage.count; i += 1) {
    doc.switchToPage(plage.start + i);

    // La marge basse est neutralisée LE TEMPS d'écrire le pied de page.
    //
    // Sans cela, pdfkit considère que le texte déborde de la zone utile et
    // ajoute une page — à chaque pied écrit. Le document gagnait ainsi trois
    // pages blanches par page réelle : 7 pages devenaient 28.
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
 * Construit le PDF et renvoie son contenu.
 *
 * @param {object} d — données déjà assemblées par `rapport.service.js`
 * @returns {Promise<Buffer>}
 */
function construireRapport(d) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGE, bottom: MARGE + PIED, left: MARGE, right: MARGE },
    // Indispensable au pied de page « Page X / Y » — voir `piedsDePage`.
    bufferPages: true,
    info: {
      Title: val(d.titre, 'Rapport de chantier'),
      Author: val(d.organisation?.nom, 'Suivie Chantier'),
      Subject: val(d.chantier?.nom, ''),
    },
  });

  const morceaux = [];
  doc.on('data', (c) => morceaux.push(c));
  const termine = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
  });

  pageDeGarde(doc, d);
  sectionParticipants(doc, d);
  sectionEntreprises(doc, d);
  sectionSynthese(doc, d);
  sectionReserves(doc, d);
  sectionATraiter(doc, d);
  sectionRemarques(doc, d);
  sectionPointsAVerifier(doc, d);
  sectionSources(doc, d);

  piedsDePage(doc, d);

  doc.end();
  return termine;
}

module.exports = {
  construireRapport,
  // Exportés pour les tests : ce sont eux qui portent la règle « aucune
  // invention » et les libellés métier.
  val,
  dateFr,
  LIBELLE_STATUT,
  LIBELLE_SEVERITE,
  LIBELLE_ROLE,
  LIBELLE_PRESENCE,
  LIBELLE_TYPE_PARTENAIRE,
};
