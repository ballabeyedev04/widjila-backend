'use strict';

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const { AbonnementSouscrit, Organisation, Utilisateur } = require('../../../models/index.js');
const { storeFile } = require('../../../infrastructure/storage.service.js');
const { sendRecuPaiementEmail } = require('../../../infrastructure/emailService.js');
const logger = require('../../../utils/logger.js');

/**
 * Reçu de paiement — le PDF, son archivage et son envoi.
 *
 * ## Pourquoi il existe
 *
 * L'application enregistrait la souscription et l'affichait dans l'historique,
 * mais n'envoyait RIEN au client. Or ce sont des entreprises : elles ont besoin
 * d'une pièce pour leur comptabilité, et la réclamer au support pour chaque
 * paiement est un coût des deux côtés.
 *
 * ## Ce que ce reçu est, et n'est pas
 *
 * C'est un JUSTIFICATIF DE PAIEMENT : il atteste qu'une somme a été réglée, à
 * quelle date, pour quelle formule. Ce n'est pas une facture au sens comptable
 * français — pas de numérotation légale continue, pas de mentions de TVA, qui
 * dépendent du régime de l'émetteur et du pays du client. Le document le dit
 * lui-même en pied de page, plutôt que de laisser croire à ce qu'il n'est pas.
 *
 * ## Best-effort, toujours
 *
 * Aucune étape ne peut faire échouer l'activation de l'abonnement. Un paiement
 * encaissé puis perdu parce que la génération d'un PDF a échoué serait le pire
 * des deux mondes. Chaque échec est journalisé, jamais propagé.
 */

// Palette de la marque — `--primary` de l'admin web, `AppColors` du mobile.
const ORANGE = '#F2600C';
const ENCRE = '#1F2937';
const GRIS = '#6B7280';
const TRAIT = '#E5E7EB';

const LOGO = path.join(__dirname, '..', '..', '..', 'assets', 'logo-widjila.png');

/** Emetteur — surchargeable par l'environnement, sans quoi rien n'est inventé. */
const EMETTEUR = {
  nom: process.env.SOCIETE_NOM || 'Widjila',
  adresse: process.env.SOCIETE_ADRESSE || '',
  email: process.env.SOCIETE_EMAIL || process.env.MAIL_FROM || '',
  siret: process.env.SOCIETE_SIRET || '',
};

/** Libellé d'une périodicité, tel qu'il se lit sur un reçu. */
const PERIODES = {
  mensuel: 'Mensuel',
  trimestriel: 'Trimestriel',
  semestriel: 'Semestriel',
  annuel: 'Annuel',
};

/**
 * Numéro du reçu — lisible, stable, et sans prétention de séquence légale.
 *
 * Construit sur la date et les 6 derniers caractères de l'identifiant de la
 * souscription : deux reçus ne peuvent pas porter le même, et le numéro se
 * retrouve dans la base à partir du papier.
 */
function numeroRecu(souscription) {
  const d = souscription.date_debut ? new Date(souscription.date_debut) : new Date();
  const annee = d.getFullYear();
  const mois = String(d.getMonth() + 1).padStart(2, '0');
  const suffixe = String(souscription.id).replace(/-/g, '').slice(-6).toUpperCase();
  return `WJ-${annee}${mois}-${suffixe}`;
}

/** Date en toutes lettres, format français. */
function jour(valeur) {
  if (!valeur) return '—';
  return new Date(valeur).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

/** Montant formaté avec sa devise. */
function montant(valeur, devise) {
  const nombre = Number(valeur);
  if (!Number.isFinite(nombre)) return '—';
  return `${nombre.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${String(devise || 'EUR').toUpperCase()}`;
}

/**
 * Dessine le reçu et rend ses octets.
 *
 * `pdfkit` écrit dans un flux : on le collecte en mémoire plutôt que sur
 * disque, le document pesant quelques dizaines de kilo-octets.
 */
function genererPdf({ souscription, organisation, payeur }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const morceaux = [];

    doc.on('data', (c) => morceaux.push(c));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);

    const G = 50; // marge gauche
    const D = 545; // bord droit du contenu
    const numero = numeroRecu(souscription);

    // ── En-tête : le titre à gauche, le logo à DROITE et discret ───────────
    //
    // Un logo qui écrase la page ferait un prospectus, pas un justificatif.
    // 92 points de large : reconnaissable, sans voler la vedette au montant.
    if (fs.existsSync(LOGO)) {
      try {
        doc.image(LOGO, D - 92, 46, { width: 92 });
      } catch (e) {
        // Un logo illisible ne doit pas coûter le reçu.
        logger.warn(`[recu] Logo non intégré : ${e.message}`);
      }
    }

    doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(20)
      .text('REÇU DE PAIEMENT', G, 52);

    doc.fillColor(GRIS).font('Helvetica').fontSize(9.5)
      .text(`N° ${numero}`, G, 78);

    doc.moveTo(G, 118).lineTo(D, 118).lineWidth(1).strokeColor(TRAIT).stroke();

    // ── Émetteur / destinataire, côte à côte ───────────────────────────────
    let y = 136;

    const bloc = (titre, lignes, x, largeur) => {
      doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(8)
        .text(titre.toUpperCase(), x, y, { width: largeur, characterSpacing: 0.6 });
      let yy = y + 15;
      for (const ligne of lignes.filter(Boolean)) {
        doc.fillColor(ENCRE).font('Helvetica').fontSize(10)
          .text(ligne, x, yy, { width: largeur });
        yy = doc.y + 1;
      }
      return yy;
    };

    const basGauche = bloc('Émetteur', [
      EMETTEUR.nom,
      EMETTEUR.adresse,
      EMETTEUR.email,
      EMETTEUR.siret ? `SIRET ${EMETTEUR.siret}` : null,
    ], G, 220);

    const basDroit = bloc('Payé par', [
      organisation?.nom,
      payeur ? [payeur.prenom, payeur.nom].filter(Boolean).join(' ') : null,
      payeur?.email || organisation?.email,
      [organisation?.adresse, organisation?.ville].filter(Boolean).join(', ') || null,
    ], 320, 225);

    y = Math.max(basGauche, basDroit) + 26;

    // ── Le détail, en tableau ──────────────────────────────────────────────
    doc.rect(G, y, D - G, 26).fill('#FFF4EC');
    doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(9)
      .text('DÉSIGNATION', G + 12, y + 9)
      .text('MONTANT', D - 112, y + 9, { width: 100, align: 'right' });

    y += 26;

    const ligne = (libelle, valeur, gras = false) => {
      doc.fillColor(ENCRE)
        .font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
        .text(libelle, G + 12, y + 9, { width: 300 });
      if (valeur != null) {
        doc.font(gras ? 'Helvetica-Bold' : 'Helvetica')
          .text(valeur, D - 152, y + 9, { width: 140, align: 'right' });
      }
      y += 30;
      doc.moveTo(G, y).lineTo(D, y).lineWidth(0.5).strokeColor(TRAIT).stroke();
    };

    ligne(
      `Abonnement ${souscription.plan_nom || souscription.plan_code}`,
      montant(souscription.prix_paye, souscription.devise)
    );

    // Le détail de la période : c'est ce que le comptable regarde en second,
    // juste après le montant.
    doc.fillColor(GRIS).font('Helvetica').fontSize(9)
      .text(
        `Périodicité : ${PERIODES[souscription.periode] || souscription.periode || '—'}`
        + `   ·   Du ${jour(souscription.date_debut)} au ${jour(souscription.date_fin)}`,
        G + 12, y - 22, { width: 380 }
      );

    y += 8;

    // ── Total ──────────────────────────────────────────────────────────────
    doc.rect(D - 262, y, 262, 42).fill(ENCRE);
    doc.fillColor('#FFFFFF').font('Helvetica').fontSize(10)
      .text('TOTAL PAYÉ', D - 250, y + 15);
    doc.font('Helvetica-Bold').fontSize(15)
      .text(montant(souscription.prix_paye, souscription.devise), D - 250, y + 11, {
        width: 238, align: 'right',
      });

    y += 66;

    // ── Références du paiement ─────────────────────────────────────────────
    doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(8)
      .text('RÈGLEMENT', G, y, { characterSpacing: 0.6 });
    y += 15;

    const reference = souscription.reference_paiement
      ? `Référence : ${souscription.reference_paiement}`
      : null;

    for (const l of [
      `Moyen de paiement : ${souscription.fournisseur === 'paytech' ? 'Mobile Money' : 'Carte bancaire'}`,
      `Date du règlement : ${jour(souscription.date_debut)}`,
      reference,
    ].filter(Boolean)) {
      doc.fillColor(ENCRE).font('Helvetica').fontSize(9.5).text(l, G, y);
      y = doc.y + 2;
    }

    // ── Pied de page ───────────────────────────────────────────────────────
    //
    // Dire ce que le document EST évite qu'on le prenne pour ce qu'il n'est
    // pas. Une entreprise qui le présente comme facture s'en apercevrait au
    // mauvais moment.
    doc.moveTo(G, 742).lineTo(D, 742).lineWidth(0.5).strokeColor(TRAIT).stroke();
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
      .text(
        'Ce document est un justificatif de paiement généré automatiquement. '
        + 'Il atteste du règlement ci-dessus et ne constitue pas une facture au sens comptable.',
        G, 750, { width: D - G, align: 'center' }
      );

    doc.end();
  });
}

class RecuPaiementService {

  /**
   * Génère, archive et envoie le reçu d'une souscription activée.
   *
   * ## L'ordre compte
   *
   * PDF, puis archivage, puis envoi. Le courriel part en DERNIER : un reçu
   * envoyé mais introuvable ensuite dans l'historique serait plus gênant qu'un
   * reçu archivé qu'on peut renvoyer.
   *
   * ## Le destinataire
   *
   * Celui qui a PAYÉ d'abord — c'est lui qui attend la pièce et qui la
   * transmettra à sa comptabilité. À défaut, l'adresse de l'organisation :
   * mieux vaut le service comptable que personne.
   *
   * @returns {Promise<string|null>} l'URL du reçu archivé, ou `null`.
   */
  static async emettre(souscription) {
    try {
      const organisation = await Organisation.findByPk(souscription.organisationId, {
        attributes: ['id', 'nom', 'email', 'adresse', 'ville'],
      });

      const payeur = souscription.activee_par
        ? await Utilisateur.findByPk(souscription.activee_par, {
          attributes: ['id', 'nom', 'prenom', 'email'],
        })
        : null;

      const destinataire = payeur?.email || organisation?.email;
      if (!destinataire) {
        logger.warn(
          `[recu] Aucune adresse pour la souscription ${souscription.id} — reçu non envoyé`
        );
        return null;
      }

      const pdf = await genererPdf({ souscription, organisation, payeur });
      const numero = numeroRecu(souscription);

      // Archivé sur R2 quand il est configuré, sur disque sinon — c'est
      // `storeFile` qui tranche, comme pour les plans et les médias.
      const url = await storeFile(pdf, `recu-${numero}.pdf`, 'recus');

      // L'URL est conservée pour que l'historique des paiements puisse
      // proposer le reçu des mois plus tard, sans le régénérer.
      await souscription.update({ recu_url: url });

      await sendRecuPaiementEmail({
        to: destinataire,
        prenom: payeur?.prenom || '',
        organisationNom: organisation?.nom || '',
        planNom: souscription.plan_nom || souscription.plan_code,
        montant: montant(souscription.prix_paye, souscription.devise),
        numero,
        pdf,
      });

      logger.info(`[recu] Reçu ${numero} envoyé à ${destinataire}`);
      return url;
    } catch (e) {
      // Best-effort : l'abonnement est déjà actif, et le reste du parcours ne
      // doit pas dépendre d'un PDF.
      logger.error(`[recu] Reçu non émis pour ${souscription?.id} : ${e.message}`);
      return null;
    }
  }
}

module.exports = RecuPaiementService;
module.exports.genererPdf = genererPdf;
module.exports.numeroRecu = numeroRecu;
