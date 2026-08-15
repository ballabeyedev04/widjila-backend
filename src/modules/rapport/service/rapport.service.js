'use strict';

const PDFDocument = require('pdfkit');
const { Rapport, Chantier, Reserve, Inspection, Organisation } = require('../../../models/index.js');
const { storeFile } = require('../../../infrastructure/storage.service.js');

class RapportService {

  // -------------------- GÉNÉRER UN RAPPORT PDF --------------------
  /**
   * Génère un rapport PDF reflétant l'état des données au moment de la
   * génération, le stocke puis enregistre une entrée d'historique.
   *
   * @param {object} params — { chantierId, type, statut, entrepriseId, batimentId }
   * @param {string} generePar — id de l'utilisateur générateur
   * @param {string} organisationId — id de l'organisation (isolation multi-tenant)
   */
  static async genererRapport(params, generePar, organisationId) {
    const { chantierId, type = 'reserves' } = params;

    // Isolation multi-tenant : le chantier doit appartenir à l'organisation
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Données du rapport — selon le type
    const filtresReserves = { chantierId };
    if (params.statut) filtresReserves.statut = params.statut;
    if (params.entrepriseId) filtresReserves.entrepriseId = params.entrepriseId;
    if (params.batimentId) filtresReserves.batimentId = params.batimentId;

    const reserves = await Reserve.findAll({
      where: filtresReserves,
      include: [{ model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] }],
      order: [['numero', 'ASC']],
    });

    const inspections = await Inspection.findAll({
      where: { chantierId },
      order: [['createdAt', 'DESC']],
    });

    // ── Construire le PDF ────────────────────────────────────────────────
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const pdfDone = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // En-tête
    doc.rect(0, 0, doc.page.width, 90).fill('#1d4ed8');
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold')
      .text('SuivieChantier', 48, 28);
    doc.fontSize(12).font('Helvetica')
      .text('Rapport de chantier', 48, 58);

    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold')
      .text(chantier.nom, 48, 120);
    doc.fillColor('#4b5563').fontSize(10).font('Helvetica')
      .text(`Code : ${chantier.code || '—'}   •   Statut : ${chantier.statut}`, 48, 140)
      .text(`Généré le : ${new Date().toLocaleDateString('fr-FR')}   •   Type : ${type}`, 48, 156);

    doc.moveDown(2);

    // Section réserves
    doc.fillColor('#1f2937').fontSize(13).font('Helvetica-Bold')
      .text(`Réserves (${reserves.length})`);
    doc.moveDown(0.5);

    if (reserves.length === 0) {
      doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text('Aucune réserve dans ce périmètre.');
    }

    reserves.forEach((r) => {
      const entreprise = r.entreprise ? ` — ${r.entreprise.nom}` : '';
      doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold')
        .text(`${r.numero} · ${r.titre}${entreprise}`);
      doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
        .text(
          `Statut : ${r.statut}   •   Sévérité : ${r.severite}   •   Priorité : ${r.priorite}` +
          (r.date_limite ? `   •   Échéance : ${r.date_limite}` : ''),
          { indent: 8 }
        );
      if (r.description) {
        doc.fillColor('#4b5563').fontSize(9).text(r.description, { indent: 8 });
      }
      doc.moveDown(0.4);
    });

    doc.addPage();

    // Section inspections
    doc.fillColor('#1f2937').fontSize(13).font('Helvetica-Bold')
      .text(`Inspections & visites (${inspections.length})`);
    doc.moveDown(0.5);

    if (inspections.length === 0) {
      doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text('Aucune inspection enregistrée.');
    }

    inspections.forEach((i) => {
      doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold')
        .text(`${i.type} — ${i.statut}${i.date_visite ? ` (${i.date_visite})` : ''}`);
      if (i.compte_rendu) {
        doc.fillColor('#4b5563').fontSize(9).text(i.compte_rendu, { indent: 8 });
      }
      doc.moveDown(0.4);
    });

    doc.end();
    const buffer = await pdfDone;

    // ── Stockage + historique ─────────────────────────────────────────────
    const fichier_url = await storeFile(buffer, `rapport-${type}-${chantier.code || chantier.id}.pdf`, 'rapports');

    const rapport = await Rapport.create({
      chantierId,
      type,
      fichier_url,
      generePar,
      parametres: params,
    });

    return { success: true, message: 'Rapport généré avec succès', rapport };
  }

  // -------------------- LISTER LES RAPPORTS D'UN CHANTIER --------------------
  static async listRapports(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const rapports = await Rapport.findAll({
      where: { chantierId },
      order: [['createdAt', 'DESC']],
    });
    return { success: true, rapports };
  }

  // -------------------- DÉTAIL D'UN RAPPORT --------------------
  static async getRapport(rapportId, organisationId) {
    const rapport = await Rapport.findByPk(rapportId, {
      include: [
        // Scoping multi-tenant : le chantier doit appartenir à l'organisation
        { model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id', 'nom'] },
      ],
    });
    if (!rapport || !rapport.chantier) {
      return { success: false, message: 'Rapport introuvable dans cette organisation' };
    }
    return { success: true, rapport };
  }

  // -------------------- SUPPRIMER UN RAPPORT --------------------
  static async supprimerRapport(organisationId, rapportId) {
    const rapport = await Rapport.findByPk(rapportId, {
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    await rapport.destroy(); // soft delete
    return { success: true, message: 'Rapport supprimé' };
  }
}

module.exports = RapportService;
