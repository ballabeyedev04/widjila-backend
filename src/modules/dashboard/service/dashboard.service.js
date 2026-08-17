'use strict';

const { Op, fn, col } = require('sequelize');
const ExcelJS = require('exceljs');
const {
  Chantier, Reserve, ReserveHistorique, Batiment, Plan, Inspection, Document, Utilisateur, Organisation,
} = require('../../../models/index.js');
const cache = require('../../../utils/cache.js');

const STATUTS_FERMES = ['validee', 'cloturee'];

class DashboardService {

  // -------------------- STATISTIQUES GLOBALES DE L'ORGANISATION --------------------
  /**
   * Correctif (audit — Performance §2 / N+1 §6) : la version précédente
   * bouclait sur chaque chantier pour construire `parChantier` (1 findByPk +
   * 3 count PAR chantier) — 4×N requêtes, N étant le nombre de chantiers de
   * l'organisation. Remplacé par 2 requêtes groupées (`GROUP BY chantierId`)
   * assemblées en mémoire, sur le modèle déjà utilisé par
   * `ChantierService.listChantiers`. Coût désormais constant, quel que soit
   * le nombre de chantiers.
   *
   * Résultat mis en cache 45s (best-effort, no-op si Redis absent) : c'est
   * l'endpoint le plus lourd et le plus rafraîchi (écran d'accueil), donc le
   * premier à saturer la base si beaucoup d'utilisateurs l'ouvrent en même
   * temps (audit — Charge à 10 000 utilisateurs §4).
   */
  static async statsGlobales(organisationId) {
    const cleCache = `dashboard:stats-globales:${organisationId}`;
    const enCache = await cache.lire(cleCache);
    if (enCache) return enCache;

    const chantiers = await Chantier.findAll({
      where: { organisationId },
      attributes: ['id', 'nom', 'code', 'statut'],
      raw: true,
    });
    const chantierIds = chantiers.map((c) => c.id);

    let stats = {
      chantiers: chantiers.length,
      reserves: { total: 0, ouvertes: 0, validees: 0, refusees: 0, enRetard: 0 },
      parStatut: {},
      parSeverite: {},
      parChantier: [],
      plans: 0,
      inspections: 0,
      documents: 0,
      utilisateurs: await Utilisateur.count({ where: { organisationId } }),
    };

    if (chantierIds.length === 0) {
      const resultat = { success: true, stats };
      await cache.ecrire(cleCache, resultat);
      return resultat;
    }

    const whereChantiers = { chantierId: chantierIds };

    // Toutes les requêtes d'agrégation sont indépendantes : lancées en
    // parallèle plutôt qu'en série pour ne payer qu'un seul aller-retour de
    // latence réseau vers la base au lieu de neuf.
    const [
      parStatut, parSeverite,
      total, ouvertes, validees, refusees, enRetard,
      plans, inspections, documents,
      reservesParChantierStatut, batimentsParChantier,
    ] = await Promise.all([
      Reserve.findAll({ where: whereChantiers, attributes: ['statut', [fn('COUNT', col('id')), 'n']], group: ['statut'], raw: true }),
      Reserve.findAll({ where: whereChantiers, attributes: ['severite', [fn('COUNT', col('id')), 'n']], group: ['severite'], raw: true }),
      Reserve.count({ where: whereChantiers }),
      Reserve.count({ where: { ...whereChantiers, statut: { [Op.notIn]: STATUTS_FERMES } } }),
      Reserve.count({ where: { ...whereChantiers, statut: 'validee' } }),
      Reserve.count({ where: { ...whereChantiers, statut: 'refusee' } }),
      // Réserves en retard : échéance passée et non clôturée/validée
      Reserve.count({ where: { ...whereChantiers, date_limite: { [Op.lt]: new Date() }, statut: { [Op.notIn]: STATUTS_FERMES } } }),
      Plan.count({ where: whereChantiers }),
      Inspection.count({ where: whereChantiers }),
      Document.count({ where: whereChantiers }),
      // Résumé par chantier — UNE requête groupée par (chantierId, statut)
      // au lieu d'un count() par chantier.
      Reserve.findAll({
        where: whereChantiers,
        attributes: ['chantierId', 'statut', [fn('COUNT', col('id')), 'n']],
        group: ['chantierId', 'statut'],
        raw: true,
      }),
      Batiment.findAll({
        where: whereChantiers,
        attributes: ['chantierId', [fn('COUNT', col('id')), 'n']],
        group: ['chantierId'],
        raw: true,
      }),
    ]);

    for (const row of parStatut) stats.parStatut[row.statut] = Number(row.n);
    for (const row of parSeverite) stats.parSeverite[row.severite] = Number(row.n);
    stats.reserves = { total, ouvertes, validees, refusees, enRetard };
    stats.plans = plans;
    stats.inspections = inspections;
    stats.documents = documents;

    const batimentsParChantierMap = new Map(batimentsParChantier.map((b) => [b.chantierId, Number(b.n)]));
    const parChantierMap = new Map(chantiers.map((c) => [c.id, {
      id: c.id,
      nom: c.nom,
      code: c.code,
      statut: c.statut,
      reserves: { total: 0, ouvertes: 0 },
      batiments: batimentsParChantierMap.get(c.id) || 0,
    }]));
    for (const row of reservesParChantierStatut) {
      const entree = parChantierMap.get(row.chantierId);
      if (!entree) continue;
      const n = Number(row.n);
      entree.reserves.total += n;
      if (!STATUTS_FERMES.includes(row.statut)) entree.reserves.ouvertes += n;
    }
    stats.parChantier = Array.from(parChantierMap.values());

    const resultat = { success: true, stats };
    await cache.ecrire(cleCache, resultat);
    return resultat;
  }

  // -------------------- STATISTIQUES D'UN CHANTIER --------------------
  static async statsChantier(organisationId, chantierId) {
    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [{ model: Utilisateur, as: 'responsable', attributes: ['id', 'nom', 'prenom', 'photoProfil'] }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Requêtes indépendantes lancées en parallèle (même logique que
    // statsGlobales) plutôt qu'une cascade de `await` séquentiels.
    const [
      total, ouvertes, validees, enRetard, parSeverite, parStatutRows, batiments, plans, inspections, documents,
    ] = await Promise.all([
      Reserve.count({ where: { chantierId } }),
      Reserve.count({ where: { chantierId, statut: { [Op.notIn]: ['validee', 'cloturee'] } } }),
      Reserve.count({ where: { chantierId, statut: 'validee' } }),
      Reserve.count({
        where: { chantierId, date_limite: { [Op.lt]: new Date() }, statut: { [Op.notIn]: ['validee', 'cloturee'] } },
      }),
      Reserve.findAll({
        where: { chantierId },
        attributes: ['severite', [fn('COUNT', col('id')), 'n']],
        group: ['severite'],
        raw: true,
      }),
      // Répartition par statut — alimente les compteurs de filtre et le
      // donut de l'écran mobile « Réserves » : les chiffres viennent du
      // back, seul le rendu graphique est fait côté client (mobile/web).
      Reserve.findAll({
        where: { chantierId },
        attributes: ['statut', [fn('COUNT', col('id')), 'n']],
        group: ['statut'],
        raw: true,
      }),
      Batiment.count({ where: { chantierId } }),
      Plan.count({ where: { chantierId } }),
      Inspection.count({ where: { chantierId } }),
      Document.count({ where: { chantierId } }),
    ]);

    const stats = {
      chantier,
      reserves: { total, ouvertes, validees, enRetard },
      parSeverite: parSeverite.reduce((acc, r) => ({ ...acc, [r.severite]: Number(r.n) }), {}),
      parStatut: parStatutRows.reduce((acc, r) => ({ ...acc, [r.statut]: Number(r.n) }), {}),
      batiments,
      plans,
      inspections,
      documents,
    };

    return { success: true, stats };
  }

  // -------------------- RÉSERVES PAR ENTREPRISE (module 9) --------------------
  /** Répartition des réserves par entreprise en charge (incl. filiales). */
  static async statsParEntreprise(organisationId) {
    const chantierIds = (await Chantier.findAll({
      where: { organisationId },
      attributes: ['id'],
      raw: true,
    })).map((c) => c.id);

    if (!chantierIds.length) return { success: true, stats: [] };

    const reserves = await Reserve.findAll({
      where: { chantierId: chantierIds },
      include: [{ model: Organisation, as: 'entreprise', attributes: ['id', 'nom'] }],
      attributes: ['id', 'statut', 'entrepriseId'],
    });

    const map = new Map();
    for (const r of reserves) {
      const cle = r.entrepriseId || 'non_affecte';
      const nom = r.entreprise ? r.entreprise.nom : 'Non affectée';
      if (!map.has(cle)) {
        map.set(cle, { entrepriseId: cle, nom, total: 0, ouvertes: 0, validees: 0, enRetard: 0 });
      }
      const e = map.get(cle);
      e.total += 1;
      if (r.statut === 'validee') e.validees += 1;
      if (!['validee', 'cloturee'].includes(r.statut)) e.ouvertes += 1;
      if (r.statut === 'en_retard') e.enRetard += 1;
    }

    const stats = Array.from(map.values()).sort((a, b) => b.total - a.total);
    return { success: true, stats };
  }

  // -------------------- RÉSERVES PAR BÂTIMENT (module 9) --------------------
  static async statsParBatiment(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const batiments = await Batiment.findAll({
      where: { chantierId },
      include: [{ model: Reserve, as: 'reserves', attributes: ['id', 'statut', 'severite'] }],
      attributes: ['id', 'nom'],
    });

    const stats = batiments.map((b) => {
      const reserves = b.reserves || [];
      const parSeverite = {};
      for (const r of reserves) parSeverite[r.severite] = (parSeverite[r.severite] || 0) + 1;
      return {
        id: b.id,
        nom: b.nom,
        reserves: reserves.length,
        ouvertes: reserves.filter((r) => !['validee', 'cloturee'].includes(r.statut)).length,
        validees: reserves.filter((r) => r.statut === 'validee').length,
        enRetard: reserves.filter((r) => r.statut === 'en_retard').length,
        parSeverite,
      };
    });

    return { success: true, stats };
  }

  // -------------------- DÉLAI MOYEN DE TRAITEMENT (module 9) --------------------
  /**
   * Délai moyen (jours) entre la création d'une réserve et sa validation,
   * calculé depuis l'historique (action 'creation' → action 'validation').
   */
  static async dureeTraitement(organisationId, chantierId = null) {
    const whereChantier = {};
    if (chantierId) {
      const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
      if (!chantier) return { success: false, message: 'Chantier introuvable' };
      whereChantier.chantierId = chantierId;
    } else {
      whereChantier.chantierId = {
        [Op.in]: (await Chantier.findAll({ where: { organisationId }, attributes: ['id'], raw: true })).map((c) => c.id),
      };
    }

    const creations = await ReserveHistorique.findAll({
      where: { ...whereChantier, action: 'creation' },
      include: [{ model: Reserve, as: 'reserve', attributes: [] }],
      attributes: ['reserveId', 'createdAt'],
      raw: true,
    });
    const validations = await ReserveHistorique.findAll({
      where: { ...whereChantier, action: 'validation' },
      include: [{ model: Reserve, as: 'reserve', attributes: [] }],
      attributes: ['reserveId', 'createdAt'],
      raw: true,
    });

    const byId = new Map(creations.map((c) => [c.reserveId, new Date(c.createdAt)]));
    let cumulJours = 0;
    let n = 0;
    const delais = [];
    for (const v of validations) {
      const debut = byId.get(v.reserveId);
      if (!debut) continue;
      const jours = (new Date(v.createdAt) - debut) / (24 * 60 * 60 * 1000);
      cumulJours += jours;
      n += 1;
      delais.push({ reserveId: v.reserveId, jours: Math.round(jours * 10) / 10 });
    }

    return {
      success: true,
      stats: {
        traitees: n,
        dureeMoyenneJours: n ? Math.round((cumulJours / n) * 10) / 10 : 0,
        delais,
      },
    };
  }

  // -------------------- PRODUCTIVITÉ (module 9) --------------------
  /** Réserves validées / mois + taux de traitement. */
  static async productivite(organisationId, chantierId = null) {
    const whereChantier = { organisationId };
    if (chantierId) whereChantier.id = chantierId;

    const chantiers = await Chantier.findAll({ where: whereChantier, attributes: ['id'], raw: true });
    const chantierIds = chantiers.map((c) => c.id);
    if (!chantierIds.length) return { success: true, stats: [] };

    const where = { chantierId: chantierIds };

    const total = await Reserve.count({ where });
    const validees = await Reserve.count({ where: { ...where, statut: 'validee' } });
    const enRetard = await Reserve.count({ where: { ...where, statut: 'en_retard' } });

    // Créations par mois (sur 6 derniers mois)
    const depuis = new Date();
    depuis.setMonth(depuis.getMonth() - 6);
    const mois = await Reserve.findAll({
      where: { ...where, createdAt: { [Op.gte]: depuis } },
      attributes: [
        [fn('to_char', col('createdAt'), 'YYYY-MM'), 'mois'],
        [fn('COUNT', col('id')), 'n'],
      ],
      group: ['mois'],
      order: [[fn('to_char', col('createdAt'), 'YYYY-MM'), 'ASC']],
      raw: true,
    });

    const stats = {
      total,
      validees,
      enRetard,
      tauxTraitement: total ? Math.round((validees / total) * 1000) / 10 : 0,
      parMois: mois.map((m) => ({ mois: m.mois, creees: Number(m.n) })),
    };
    return { success: true, stats };
  }

  // -------------------- ÉVOLUTION / COMPARAISON PÉRIODES (module 9) --------------------
  /**
   * Évolution mensuelle des réserves créées/validées, plus comparaison
   * avec la période précédente (glissement annuel).
   */
  static async evolution(organisationId, chantierId = null) {
    const whereChantier = { organisationId };
    if (chantierId) whereChantier.id = chantierId;

    const chantiers = await Chantier.findAll({ where: whereChantier, attributes: ['id'], raw: true });
    const chantierIds = chantiers.map((c) => c.id);
    if (!chantierIds.length) return { success: true, stats: { series: [], comparaison: {} } };

    const now = new Date();
    const debutAnnee = new Date(now.getFullYear(), 0, 1);
    const anneePrec = new Date(now.getFullYear() - 1, 0, 1);

    const where = { chantierId: chantierIds };

    const series = await Promise.all([
      Reserve.findAll({
        where: { ...where, createdAt: { [Op.gte]: debutAnnee } },
        attributes: [[fn('to_char', col('createdAt'), 'YYYY-MM'), 'mois'], [fn('COUNT', col('id')), 'n']],
        group: ['mois'], order: [[fn('to_char', col('createdAt'), 'YYYY-MM'), 'ASC']], raw: true,
      }).then((rows) => rows.map((r) => ({ mois: r.mois, creees: Number(r.n) }))),
      Reserve.findAll({
        where: {
          ...where,
          statut: 'validee',
          updatedAt: { [Op.gte]: debutAnnee },
        },
        attributes: [[fn('to_char', col('updatedAt'), 'YYYY-MM'), 'mois'], [fn('COUNT', col('id')), 'n']],
        group: ['mois'], order: [[fn('to_char', col('updatedAt'), 'YYYY-MM'), 'ASC']], raw: true,
      }).then((rows) => rows.map((r) => ({ mois: r.mois, validees: Number(r.n) }))),
    ]);

    const creees = series[0];
    const validees = series[1];
    const moisMap = new Map();
    for (const r of creees) moisMap.set(r.mois, { mois: r.mois, creees: r.creees, validees: 0 });
    for (const r of validees) {
      if (!moisMap.has(r.mois)) moisMap.set(r.mois, { mois: r.mois, creees: 0, validees: 0 });
      moisMap.get(r.mois).validees = r.validees;
    }
    const timeline = Array.from(moisMap.values()).sort((a, b) => a.mois.localeCompare(b.mois));

    // Comparaison année en cours vs année précédente
    const countAnnee = (debut, fin) => Reserve.count({ where: { ...where, createdAt: { [Op.gte]: debut, [Op.lt]: fin } } });
    const [courante, precedente] = await Promise.all([
      countAnnee(debutAnnee, new Date(now.getFullYear() + 1, 0, 1)),
      countAnnee(anneePrec, debutAnnee),
    ]);

    const comparaison = {
      anneeCourante: courante,
      anneePrecedente: precedente,
      variationPct: precedente ? Math.round(((courante - precedente) / precedente) * 1000) / 10 : null,
    };

    return { success: true, stats: { series: timeline, comparaison } };
  }

  // -------------------- EXPORT EXCEL DES KPI (module 9) --------------------
  /** Génère un classeur Excel avec les principaux indicateurs. */
  static async exportExcel(organisationId) {
    const [globale, parEntreprise, delais] = await Promise.all([
      DashboardService.statsGlobales(organisationId),
      DashboardService.statsParEntreprise(organisationId),
      DashboardService.dureeTraitement(organisationId),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SuiviChantier API';
    wb.created = new Date();

    // Feuille KPI globaux
    const ws = wb.addWorksheet('KPI');
    ws.columns = [
      { header: 'Indicateur', key: 'indicateur', width: 30 },
      { header: 'Valeur', key: 'valeur', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    const s = globale.stats;
    const lignes = [
      ['Chantiers', s.chantiers],
      ['Réserves (total)', s.reserves.total],
      ['Réserves ouvertes', s.reserves.ouvertes],
      ['Réserves validées', s.reserves.validees],
      ['Réserves refusées', s.reserves.refusees],
      ['Réserves en retard', s.reserves.enRetard],
      ['Plans', s.plans],
      ['Inspections', s.inspections],
      ['Documents', s.documents],
      ['Utilisateurs', s.utilisateurs],
    ];
    for (const [indicateur, valeur] of lignes) ws.addRow({ indicateur, valeur });

    // Feuille par entreprise
    const ws2 = wb.addWorksheet('Par entreprise');
    ws2.columns = [
      { header: 'Entreprise', key: 'nom', width: 30 },
      { header: 'Total', key: 'total', width: 12 },
      { header: 'Ouvertes', key: 'ouvertes', width: 12 },
      { header: 'Validées', key: 'validees', width: 12 },
      { header: 'En retard', key: 'enRetard', width: 12 },
    ];
    ws2.getRow(1).font = { bold: true };
    for (const e of parEntreprise.stats) ws2.addRow(e);

    // Feuille délais
    const ws3 = wb.addWorksheet('Délais');
    ws3.columns = [
      { header: 'Indicateur', key: 'indicateur', width: 30 },
      { header: 'Valeur', key: 'valeur', width: 16 },
    ];
    ws3.getRow(1).font = { bold: true };
    ws3.addRow({ indicateur: 'Réserves traitées', valeur: delais.stats.traitees });
    ws3.addRow({ indicateur: 'Délai moyen (jours)', valeur: delais.stats.dureeMoyenneJours });

    const buffer = await wb.xlsx.writeBuffer();
    return { success: true, buffer, filename: `kpi-${organisationId}.xlsx` };
  }
}

module.exports = DashboardService;
