'use strict';

const {
  PDFDocument, StandardFonts, rgb, degrees,
  pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath,
} = require('pdf-lib');
const logger = require('../../../utils/logger.js');

/**
 * Incrustation des extraits de PLAN et des pastilles — § 7 du cahier des
 * charges.
 *
 * ── Pourquoi une seconde passe ─────────────────────────────────────────────
 *
 * « Les coordonnées X/Y normalisées permettent au générateur de rapport de
 * replacer automatiquement une pastille sur le plan ou sur un extrait du
 * plan. » Encore faut-il pouvoir DESSINER le plan. Or les plans de chantier
 * sont presque toujours des PDF, et pdfkit — qui compose le rapport — ne sait
 * dessiner que des images matricielles. Rastériser un PDF demanderait un
 * moteur de rendu (poppler, mupdf) que le serveur n'a pas, et qui produirait
 * de toute façon une image floue au zoom, là où un plan doit rester lisible
 * jusqu'au détail d'une pièce.
 *
 * La composition réserve donc un EMPLACEMENT vide par extrait, et ce module
 * rouvre le document terminé avec pdf-lib pour y incruster la page réelle du
 * plan — en VECTORIEL — puis la pastille par-dessus.
 *
 * ── Ce que ce module garantit ──────────────────────────────────────────────
 *
 * Un plan illisible, chiffré, absent ou d'un format inattendu ne fait jamais
 * échouer le rapport : l'emplacement reçoit alors une mention explicite, et
 * la position en pourcentage reste imprimée par la première passe.
 */

/** Agrandissement de la vue « extrait » — assez pour lire une pièce. */
const ZOOM_EXTRAIT = 3;

/** Couleur de la pastille : celle de l'application. */
const ORANGE = rgb(0.949, 0.376, 0.047);
const BLANC = rgb(1, 1, 1);
const GRIS = rgb(0.58, 0.64, 0.71);

/**
 * Dimensions de la page TELLE QU'ELLE EST AFFICHÉE.
 *
 * Une page portant `/Rotate 90` est stockée à l'horizontale et affichée à la
 * verticale. Les coordonnées de la réserve ont été relevées sur ce que
 * l'utilisateur VOYAIT : ignorer la rotation poserait la pastille à angle
 * droit de l'endroit visé.
 */
function dimensionsAffichees(page) {
  const { width, height } = page.getSize();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const tourne = angle === 90 || angle === 270;
  return {
    angle,
    largeur: tourne ? height : width,
    hauteur: tourne ? width : height,
    largeurSource: width,
    hauteurSource: height,
  };
}

/**
 * Point d'ancrage à donner à `drawPage` pour qu'une page tournée occupe
 * exactement le rectangle voulu.
 *
 * pdf-lib place le coin inférieur gauche du contenu en (x, y) PUIS applique
 * la rotation autour de ce même point. Le coin visé se déplace donc avec la
 * rotation, et il faut le compenser — sinon la page part hors du cadre.
 */
function ancrage(angle, gaucheX, basY, largeurDessin, hauteurDessin, largeurSource, hauteurSource, echelle) {
  const ws = largeurSource * echelle;
  const hs = hauteurSource * echelle;
  switch (angle) {
    case 90: return { x: gaucheX, y: basY + hauteurDessin, rotation: degrees(-90) };
    case 180: return { x: gaucheX + ws, y: basY + hs, rotation: degrees(180) };
    case 270: return { x: gaucheX + largeurDessin, y: basY, rotation: degrees(90) };
    default: return { x: gaucheX, y: basY, rotation: degrees(0) };
  }
}

/**
 * Où dessiner le plan, et où poser la PASTILLE — tout le § 7 tient ici.
 *
 * Fonction PURE, séparée du dessin, pour que le critère d'acceptation du
 * § 23 (« Plan : pastille au bon emplacement ») se vérifie par le calcul
 * plutôt qu'à l'œil sur un PDF.
 *
 * @param {object} e — emplacement réservé par la première passe (coordonnées
 *   pdfkit : origine en HAUT à gauche) avec `xNorm`/`yNorm` entre 0 et 1
 * @param {object} dims — `dimensionsAffichees(page)`
 * @param {number} hauteurPage — hauteur de la page du rapport
 * @returns {{cadre, echelle, dessin, ancrage, pastille}} coordonnées pdf-lib
 *   (origine en BAS à gauche). `pastille` est nul si la position est inconnue.
 */
function calculerPlacement(e, dims, hauteurPage) {
  // pdfkit compte depuis le HAUT de la page, pdf-lib depuis le BAS : la
  // conversion se fait ici, une fois.
  const cadre = {
    x: e.x,
    y: hauteurPage - e.y - e.hauteur,
    largeur: e.largeur,
    hauteur: e.hauteur,
  };

  const positionConnue = typeof e.xNorm === 'number' && typeof e.yNorm === 'number';
  const zoom = (e.mode === 'extrait' && positionConnue) ? ZOOM_EXTRAIT : 1;

  const echelle = Math.min(cadre.largeur / dims.largeur, cadre.hauteur / dims.hauteur) * zoom;
  const largeurDessin = dims.largeur * echelle;
  const hauteurDessin = dims.hauteur * echelle;

  let gaucheX;
  let basY;
  if (zoom > 1) {
    // Vue centrée sur la réserve, puis ramenée dans le cadre : un extrait qui
    // déborderait du plan afficherait du vide au lieu du bâtiment.
    gaucheX = cadre.x + cadre.largeur / 2 - e.xNorm * largeurDessin;
    basY = cadre.y + cadre.hauteur / 2 - (1 - e.yNorm) * hauteurDessin;
    gaucheX = Math.min(cadre.x, Math.max(cadre.x + cadre.largeur - largeurDessin, gaucheX));
    basY = Math.min(cadre.y, Math.max(cadre.y + cadre.hauteur - hauteurDessin, basY));
  } else {
    gaucheX = cadre.x + (cadre.largeur - largeurDessin) / 2;
    basY = cadre.y + (cadre.hauteur - hauteurDessin) / 2;
  }

  return {
    cadre,
    echelle,
    dessin: { x: gaucheX, y: basY, largeur: largeurDessin, hauteur: hauteurDessin },
    ancrage: ancrage(
      dims.angle, gaucheX, basY, largeurDessin, hauteurDessin,
      dims.largeurSource, dims.hauteurSource, echelle,
    ),
    // `yNorm` se compte depuis le HAUT du plan affiché (c'est ainsi que
    // l'application le relève) ; pdf-lib compte depuis le bas.
    pastille: positionConnue
      ? { x: gaucheX + e.xNorm * largeurDessin, y: basY + hauteurDessin - e.yNorm * hauteurDessin }
      : null,
  };
}

/** Rectangle de découpe — tout ce qui déborde de l'emplacement est masqué. */
function decouper(page, x, y, largeur, hauteur) {
  page.pushOperators(
    pushGraphicsState(),
    moveTo(x, y),
    lineTo(x + largeur, y),
    lineTo(x + largeur, y + hauteur),
    lineTo(x, y + hauteur),
    closePath(),
    clip(),
    endPath(),
  );
}

/** La pastille : disque orange, anneau blanc, cercle de visée. */
function dessinerPastille(page, x, y) {
  page.drawCircle({ x, y, size: 7, color: BLANC, opacity: 0.85 });
  page.drawCircle({ x, y, size: 4.5, color: ORANGE });
  page.drawCircle({ x, y, size: 10, borderColor: ORANGE, borderWidth: 1, opacity: 0 });
}

/**
 * Incruste les extraits de plan dans le rapport déjà composé.
 *
 * @param {Buffer} pdfRapport — le document produit par `rapportPdf.js`
 * @param {Array} emplacements — les cadres réservés (voir `rapportPdf.js`)
 * @param {Map} plans — plans chargés par `rapportMedias.chargerPlans`
 * @param {number} hauteurPage — hauteur de la page du rapport, en points
 * @returns {Promise<Buffer>} le document complété (ou l'original si rien à faire)
 */
async function incrusterPlans(pdfRapport, emplacements, plans, hauteurPage) {
  const aTraiter = (emplacements || []).filter((e) => plans?.get?.(e.planId)?.buffer);
  if (!aTraiter.length) return pdfRapport;

  let rapport;
  try {
    rapport = await PDFDocument.load(pdfRapport);
  } catch (err) {
    // Le rapport reste parfaitement valable sans ses extraits de plan.
    logger.warn(`[rapport] Incrustation des plans abandonnée : ${err.message}`);
    return pdfRapport;
  }

  const police = await rapport.embedFont(StandardFonts.Helvetica);
  const pagesRapport = rapport.getPages();

  /** Documents de plan déjà ouverts, et pages déjà incorporées. */
  const documents = new Map();
  const incorporees = new Map();

  const ouvrirPlan = async (planId) => {
    if (documents.has(planId)) return documents.get(planId);
    let doc = null;
    try {
      doc = await PDFDocument.load(plans.get(planId).buffer, { ignoreEncryption: true });
      // Un fichier tronqué peut se CHARGER sans catalogue exploitable : c'est
      // le premier accès aux pages qui lève. On le fait ici, une fois, pour
      // traiter ce plan comme illisible plutôt que d'échouer plus loin.
      doc.getPageCount();
    } catch (err) {
      logger.warn(`[rapport] Plan illisible (${planId}) : ${err.message}`);
      doc = null;
    }
    documents.set(planId, doc);
    return doc;
  };

  const mentionIndisponible = (page, e) => {
    page.drawText('Aperçu du plan indisponible', {
      x: e.x + 8,
      y: hauteurPage - e.y - e.hauteur / 2,
      size: 7.5,
      font: police,
      color: GRIS,
      maxWidth: e.largeur - 16,
    });
  };

  for (const e of aTraiter) {
    const pageRapport = pagesRapport[e.page];
    if (!pageRapport) continue;

    const planDoc = await ouvrirPlan(e.planId);
    if (!planDoc) {
      mentionIndisponible(pageRapport, e);
      continue;
    }

    const nbPages = planDoc.getPageCount();
    if (!nbPages) {
      mentionIndisponible(pageRapport, e);
      continue;
    }
    // Une page hors bornes vient d'un plan remplacé par une version plus
    // courte : on retombe sur la première plutôt que d'échouer, et la légende
    // imprimée par la première passe indique la page attendue.
    const indexPage = Math.min(Math.max((e.pagePlan || 1) - 1, 0), nbPages - 1);

    const clePage = `${e.planId}#${indexPage}`;
    if (!incorporees.has(clePage)) {
      try {
        // Une page SANS contenu (page blanche d'un export raté) ne peut pas
        // être incorporée — et pdf-lib ne le découvre qu'à l'enregistrement,
        // où l'erreur ferait perdre TOUS les extraits du rapport.
        if (!planDoc.getPage(indexPage).node.Contents()) throw new Error('page de plan sans contenu');
        const [source] = await rapport.embedPdf(planDoc, [indexPage]);
        incorporees.set(clePage, { incorporee: source, page: planDoc.getPage(indexPage) });
      } catch (err) {
        logger.warn(`[rapport] Page de plan non incorporable (${clePage}) : ${err.message}`);
        incorporees.set(clePage, null);
      }
    }
    const embarquee = incorporees.get(clePage);
    if (!embarquee) {
      mentionIndisponible(pageRapport, e);
      continue;
    }

    const dims = dimensionsAffichees(embarquee.page);
    const p = calculerPlacement(e, dims, hauteurPage);

    decouper(pageRapport, p.cadre.x, p.cadre.y, p.cadre.largeur, p.cadre.hauteur);
    try {
      pageRapport.drawPage(embarquee.incorporee, {
        x: p.ancrage.x,
        y: p.ancrage.y,
        width: dims.largeurSource * p.echelle,
        height: dims.hauteurSource * p.echelle,
        rotate: p.ancrage.rotation,
      });

      if (p.pastille) dessinerPastille(pageRapport, p.pastille.x, p.pastille.y);
    } catch (err) {
      logger.warn(`[rapport] Extrait de plan non dessiné (${clePage}) : ${err.message}`);
    }
    pageRapport.pushOperators(popGraphicsState());

    // Le cadre est retracé PAR-DESSUS : le contenu du plan vient de le
    // recouvrir, et un extrait sans bordure se confond avec la page.
    pageRapport.drawRectangle({
      x: p.cadre.x, y: p.cadre.y, width: p.cadre.largeur, height: p.cadre.hauteur,
      borderColor: GRIS, borderWidth: 0.6, opacity: 0,
    });
  }

  try {
    const octets = await rapport.save({ useObjectStreams: false });
    return Buffer.from(octets);
  } catch (err) {
    // Dernier filet : le rapport sans ses extraits vaut mieux que pas de
    // rapport du tout. La position reste imprimée en clair par la première
    // passe.
    logger.warn(`[rapport] Extraits de plan abandonnés à l'enregistrement : ${err.message}`);
    return pdfRapport;
  }
}

module.exports = { incrusterPlans, calculerPlacement, dimensionsAffichees, ancrage, ZOOM_EXTRAIT };
