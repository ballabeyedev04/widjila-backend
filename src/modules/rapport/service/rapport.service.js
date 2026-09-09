'use strict';

const {
  Rapport, Chantier, Reserve, Inspection, Organisation, Utilisateur,
  ChantierMembre, Convocation, Partenaire, Lot, Batiment, Etage, Zone, Plan,
  CorpsEtat, Phase, Media,
} = require('../../../models/index.js');
const { storeFile, ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');
const pdf = require('./rapportPdf.js');

const {
  val, dateFr, LIBELLE_STATUT, LIBELLE_ROLE, LIBELLE_PRESENCE, LIBELLE_TYPE_PARTENAIRE,
} = pdf;

/**
 * Plafonds de chargement des photos.
 *
 * Une réserve peut porter une dizaine de clichés et un chantier des centaines
 * de réserves : tout charger en mémoire pour un seul PDF ferait tomber le
 * process. On borne donc, et le rapport indique combien de photos il contient
 * (section « Sources ») pour que l'absence soit visible plutôt que subie.
 */
const PHOTOS_PAR_RESERVE = 2;
const PHOTOS_TOTAL = 90;
const TAILLE_PHOTO_MAX = 4 * 1024 * 1024; // 4 Mo — au-delà, on saute la vignette

/** Statuts considérés comme « levés » : la réserve n'appelle plus d'action. */
const STATUTS_LEVES = ['validee', 'cloturee'];

/** Lit un flux de stockage en mémoire, avec plafond de taille. */
function lireBuffer(flux, tailleMax = TAILLE_PHOTO_MAX) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let total = 0;
    flux.on('data', (c) => {
      total += c.length;
      // On coupe net plutôt que d'accumuler : un fichier anormalement gros est
      // presque toujours une erreur d'import, pas une photo de chantier.
      if (total > tailleMax) {
        flux.destroy();
        resolve(null);
        return;
      }
      morceaux.push(c);
    });
    flux.on('end', () => resolve(Buffer.concat(morceaux)));
    flux.on('error', reject);
  });
}

/**
 * Charge les photos des réserves, dans les limites fixées.
 *
 * Un échec de lecture n'interrompt JAMAIS la génération : la réserve
 * apparaîtra simplement sans vignette. Un rapport amputé d'une photo reste
 * utile ; un rapport qui n'existe pas, non.
 */
async function chargerPhotos(reserves) {
  let restantes = PHOTOS_TOTAL;
  let chargees = 0;

  for (const r of reserves) {
    r.photosBuffers = [];
    if (restantes <= 0) continue;

    const medias = (r.medias || []).filter((m) => m.type === 'photo' && m.url);
    const aPrendre = medias.slice(0, Math.min(PHOTOS_PAR_RESERVE, restantes));

    for (const media of aPrendre) {
      try {
        // La vignette d'abord : plus légère, et suffisante à 104 points de
        // large. On retombe sur l'original quand elle n'existe pas.
        const fichier = await ouvrirFichier(media.thumbnail_url || media.url);
        if (!fichier || !fichier.stream) continue;
        const buffer = await lireBuffer(fichier.stream);
        if (buffer && buffer.length) {
          r.photosBuffers.push(buffer);
          restantes -= 1;
          chargees += 1;
        }
      } catch (err) {
        logger.warn(`[rapport] Photo ignorée (${media.id}) : ${err.message}`);
      }
    }
  }

  return chargees;
}

/**
 * Exécute une ÉTAPE de la génération en la nommant.
 *
 * Sans cela, les quatre étapes — lecture des données, photos, composition du
 * PDF, écriture du fichier — partagent le même « Erreur interne du serveur ».
 * L'utilisateur ne sait pas quoi corriger, et le journal ne dit pas où
 * chercher.
 *
 * L'erreur technique part au JOURNAL avec son contexte ; l'utilisateur reçoit
 * une phrase qui décrit ce qui a échoué et ce qu'il peut faire. Les deux sont
 * nécessaires : le message d'exception d'une bibliothèque PDF ne veut rien
 * dire pour un conducteur de travaux, et « réessayez » ne veut rien dire pour
 * un développeur.
 *
 * @param {string} etape       — nom technique, pour le journal
 * @param {string} messageClair — ce que l'utilisateur lira
 * @param {object} contexte    — chantier, type, volumes… pour le diagnostic
 * @param {Function} action    — le travail à exécuter
 */
/**
 * Un schéma de base EN RETARD sur le code — table ou colonne absente.
 *
 * Ce cas mérite son propre message. Il ne vient pas des données du chantier
 * mais d'une migration non appliquée, et « vérifiez le chantier et réessayez »
 * enverrait l'utilisateur chercher un problème qui n'est pas de son côté :
 * aucun rapport ne sortira tant que `npm run migrate` n'aura pas tourné.
 *
 * On reconnaît le cas au code SQLSTATE remonté par PostgreSQL — 42P01 (table
 * inconnue) et 42703 (colonne inconnue) — plutôt qu'au texte du message, qui
 * change avec la langue du serveur.
 */
function schemaEnRetard(err) {
  const code = err?.parent?.code || err?.original?.code || err?.code;
  return code === '42P01' || code === '42703';
}

async function etapeGeneration(etape, messageClair, contexte, action) {
  try {
    return await action();
  } catch (err) {
    logger.error(
      `[rapport] Échec à l'étape « ${etape} » — ${JSON.stringify(contexte)} : ${err.message}`,
      { stack: err.stack },
    );
    const echec = new Error(
      schemaEnRetard(err)
        ? 'La base de données n’est pas à jour : une migration reste à appliquer sur le serveur. Contactez le support.'
        : messageClair,
    );
    echec.etapeRapport = etape;
    throw echec;
  }
}

/** Libellé d'un utilisateur : « Prénom Nom », ou son email à défaut. */
function nomUtilisateur(u) {
  if (!u) return 'Non renseigné';
  const complet = [u.prenom, u.nom].filter(Boolean).join(' ').trim();
  return complet || val(u.email);
}

/** Chaîne de localisation d'une réserve, du plus large au plus fin. */
function localisationDe(r) {
  const parties = [r.batiment?.nom, r.etage?.nom, r.zone?.nom].filter(Boolean);
  return parties.length ? parties.join(' › ') : 'Non renseigné';
}

/**
 * Clé et libellé de REGROUPEMENT d'une réserve.
 *
 * On groupe par le PLAN quand il existe — c'est ainsi que se lisent les
 * comptes rendus d'OPR, plan par plan — et à défaut par la localisation la
 * plus fine connue. Les réserves sans aucune localisation forment leur propre
 * groupe plutôt que d'être dispersées en fin de document.
 */
function groupeDe(r) {
  if (r.plan?.nom) return { cle: `plan:${r.planId}`, libelle: `Plan ${r.plan.nom}` };
  const loc = localisationDe(r);
  if (loc !== 'Non renseigné') return { cle: `loc:${loc}`, libelle: loc };
  return { cle: 'sans', libelle: 'Sans localisation' };
}

class RapportService {

  // -------------------- GÉNÉRER UN RAPPORT PDF --------------------
  /**
   * Génère un rapport de chantier PDF : en-tête projet, participants,
   * entreprises, synthèse, réserves groupées par localisation avec leurs
   * photos, réserves à traiter, remarques, points à vérifier et sources.
   *
   * Le document reflète l'état des données AU MOMENT de la génération — c'est
   * ce qui en fait une pièce transmissible : il ne change plus ensuite.
   *
   * @param {object} params — { chantierId, type, statut, entrepriseId,
   *   partenaireId, batimentId, phaseId, corpsEtatId, inspectionId }
   * @param {string} generePar — id de l'utilisateur générateur
   * @param {string} organisationId — isolation multi-tenant
   */
  static async genererRapport(params, generePar, organisationId) {
    const { chantierId, type = 'reserves' } = params;

    // Isolation multi-tenant : le chantier doit appartenir à l'organisation.
    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom'], required: false }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // ── Périmètre ────────────────────────────────────────────────────────
    const ou = { chantierId };
    if (params.statut) ou.statut = params.statut;
    if (params.entrepriseId) ou.entrepriseId = params.entrepriseId;
    if (params.partenaireId) ou.partenaireId = params.partenaireId;
    if (params.batimentId) ou.batimentId = params.batimentId;
    if (params.phaseId) ou.phaseId = params.phaseId;
    if (params.corpsEtatId) ou.corpsEtatId = params.corpsEtatId;

    const [reserves, inspections, membres, partenaires, lots, auteur] = await etapeGeneration(
      'lecture-donnees',
      'Impossible de lire les données du chantier. Vérifiez le chantier et réessayez.',
      { chantierId, type },
      () => Promise.all([
      Reserve.findAll({
        where: ou,
        include: [
          { model: Batiment, as: 'batiment', attributes: ['id', 'nom'], required: false },
          { model: Etage, as: 'etage', attributes: ['id', 'nom'], required: false },
          { model: Zone, as: 'zone', attributes: ['id', 'nom'], required: false },
          { model: Plan, as: 'plan', attributes: ['id', 'nom'], required: false },
          { model: Lot, as: 'lot', attributes: ['id', 'nom', 'code'], required: false },
          { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom'], required: false },
          { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'], required: false },
          { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
          { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
          { model: Media, as: 'medias', attributes: ['id', 'type', 'url', 'thumbnail_url'], required: false },
        ],
        order: [['numero', 'ASC']],
      }),
      Inspection.findAll({ where: { chantierId }, order: [['createdAt', 'DESC']], limit: 20 }),
      ChantierMembre.findAll({
        where: { chantierId },
        include: [{
          model: Utilisateur, as: 'utilisateur', required: true,
          attributes: ['id', 'nom', 'prenom', 'email', 'telephone', 'fonction', 'role'],
        }],
      }),
      Partenaire.findAll({ where: { organisationId }, order: [['nom', 'ASC']] }),
      Lot.findAll({ where: { chantierId }, order: [['code', 'ASC'], ['nom', 'ASC']] }),
      generePar
        ? Utilisateur.findByPk(generePar, { attributes: ['id', 'nom', 'prenom', 'email'] })
        : Promise.resolve(null),
      ]),
    );

    // Présence : renseignée seulement quand le rapport cible une inspection.
    // Hors de ce cas, la colonne reste vide — l'inventer serait affirmer une
    // présence que personne n'a pointée.
    let presences = new Map();
    if (params.inspectionId) {
      const convocations = await Convocation.findAll({ where: { inspectionId: params.inspectionId } });
      presences = new Map(convocations.map((c) => [c.utilisateurId, c.statut]));
    }

    // Les photos ne bloquent JAMAIS un rapport : `chargerPhotos` ignore déjà
    // celle qui ne s'ouvre pas. Cette enveloppe couvre l'échec global — un
    // stockage injoignable, par exemple — et laisse le rapport se produire
    // sans images plutôt que de ne rien produire du tout.
    let nbPhotos = 0;
    try {
      nbPhotos = await chargerPhotos(reserves);
    } catch (err) {
      logger.error(
        `[rapport] Photos indisponibles (chantier ${chantierId}) : ${err.message}`,
        { stack: err.stack },
      );
      for (const r of reserves) r.photosBuffers = r.photosBuffers || [];
    }

    // ── Mise en forme ────────────────────────────────────────────────────
    const participants = membres.map((m) => ({
      nom: nomUtilisateur(m.utilisateur),
      role: LIBELLE_ROLE[m.utilisateur?.role] || val(m.utilisateur?.role),
      fonction: val(m.utilisateur?.fonction, '—'),
      email: val(m.utilisateur?.email, '—'),
      telephone: val(m.utilisateur?.telephone, '—'),
      presence: presences.has(m.utilisateurId)
        ? (LIBELLE_PRESENCE[presences.get(m.utilisateurId)] || '—')
        : '—',
    }));

    // Entreprises : les LOTS du chantier d'abord — ce sont eux qui portent le
    // numéro (« 1 - Démolitions ») — puis les partenaires de l'organisation.
    // Sans ces derniers, une entreprise référencée mais non affectée à un lot
    // disparaîtrait du rapport.
    const entreprises = lots.map((l) => ({
      lot: [l.code, l.nom].filter(Boolean).join(' - ') || 'Non renseigné',
      entreprise: val(l.corps_d_etat, '—'),
      contact: '—',
      adresse: '—',
      email: '—',
      telephone: '—',
    }));

    for (const p of partenaires) {
      entreprises.push({
        lot: LIBELLE_TYPE_PARTENAIRE[p.type] || val(p.type),
        entreprise: val(p.nom),
        contact: val(p.contact, '—'),
        adresse: val(p.adresse, '—'),
        email: val(p.email, '—'),
        telephone: val(p.telephone, '—'),
      });
    }

    const reservesVue = reserves.map((r) => ({
      id: r.id,
      numero: r.numero,
      titre: r.titre,
      description: r.description,
      statut: r.statut,
      severite: r.severite,
      createdAt: r.createdAt,
      date_limite: r.date_limite,
      date_validation: r.date_validation,
      localisation: localisationDe(r),
      lot: r.lot ? [r.lot.code, r.lot.nom].filter(Boolean).join(' - ') : 'Non renseigné',
      // L'entreprise affichée suit la même priorité que dans l'application :
      // le partenaire (l'entreprise réelle) prime, puis l'organisation, puis
      // le corps d'état à défaut de nom d'entreprise.
      entreprise: val(r.partenaire?.nom || r.entreprise?.nom || r.corpsEtat?.nom),
      phase: val(r.phase?.nom),
      photos: r.photosBuffers || [],
      planId: r.planId,
      plan: r.plan,
      batiment: r.batiment,
      etage: r.etage,
      zone: r.zone,
    }));

    // Groupement par plan / localisation, dans l'ordre de première apparition
    // (les réserves arrivent déjà triées par numéro).
    const parGroupe = new Map();
    for (const r of reservesVue) {
      const { cle, libelle } = groupeDe(r);
      if (!parGroupe.has(cle)) parGroupe.set(cle, { libelle, reserves: [] });
      parGroupe.get(cle).reserves.push(r);
    }
    const groupes = [...parGroupe.values()];

    // Répartition par phase, dans l'ordre du référentiel.
    const parPhase = new Map();
    for (const r of reserves) {
      const cle = r.phase?.id || 'sans';
      const actuel = parPhase.get(cle)
        || { phase: val(r.phase?.nom, 'Sans phase'), ordre: r.phase?.ordre ?? Number.MAX_SAFE_INTEGER, total: 0 };
      actuel.total += 1;
      parPhase.set(cle, actuel);
    }
    const repartitionPhases = [...parPhase.values()]
      .sort((a, b) => a.ordre - b.ordre)
      .map(({ phase, total }) => ({ phase, total }));

    // Réserves à traiter — non levées, les plus urgentes d'abord. Celles sans
    // échéance passent en DERNIER : les mettre en tête ferait croire à une
    // urgence que rien n'atteste.
    const aTraiter = reservesVue
      .filter((r) => !STATUTS_LEVES.includes(r.statut))
      .sort((a, b) => {
        if (!a.date_limite && !b.date_limite) return 0;
        if (!a.date_limite) return 1;
        if (!b.date_limite) return -1;
        return String(a.date_limite).localeCompare(String(b.date_limite));
      })
      .map((r) => ({
        numero: val(r.numero, '—'),
        titre: val(r.titre),
        localisation: r.localisation,
        entreprise: r.entreprise,
        echeance: dateFr(r.date_limite),
        statut: r.statut,
        statutLibelle: LIBELLE_STATUT[r.statut] || val(r.statut),
      }));

    const remarques = inspections
      .filter((i) => i.compte_rendu && String(i.compte_rendu).trim())
      .map((i) => ({
        titre: `${val(i.type)} — ${dateFr(i.date_visite || i.createdAt)}`,
        texte: String(i.compte_rendu).trim(),
      }));

    // ── Points à vérifier : CONSTATÉS, jamais devinés ────────────────────
    //
    // Chaque point est le résultat d'un comptage sur les données réellement
    // chargées. C'est ce qui permet de savoir ce qui reste à compléter AVANT
    // de diffuser le rapport aux entreprises.
    const pointsAVerifier = [];
    const compte = (predicat) => reserves.filter(predicat).length;

    const sansPhase = compte((r) => !r.phaseId);
    if (sansPhase) {
      pointsAVerifier.push(
        `${sansPhase} réserve(s) sans phase : créées avant que la phase devienne obligatoire, ou importées.`
      );
    }

    const sansEntreprise = compte((r) => !r.partenaireId && !r.entrepriseId && !r.corpsEtatId);
    if (sansEntreprise) {
      pointsAVerifier.push(`${sansEntreprise} réserve(s) sans entreprise ni corps d’état identifié.`);
    }

    const sansEcheance = compte((r) => !r.date_limite && !STATUTS_LEVES.includes(r.statut));
    if (sansEcheance) {
      pointsAVerifier.push(`${sansEcheance} réserve(s) non levée(s) sans date de levée.`);
    }

    const sansLocalisation = reservesVue.filter((r) => r.localisation === 'Non renseigné' && !r.planId).length;
    if (sansLocalisation) {
      pointsAVerifier.push(`${sansLocalisation} réserve(s) sans localisation ni plan.`);
    }

    const enRetard = compte((r) => r.statut === 'en_retard');
    if (enRetard) {
      pointsAVerifier.push(`${enRetard} réserve(s) en retard à la date de génération.`);
    }

    const sansPhoto = reserves.filter((r) => !(r.photosBuffers || []).length).length;
    if (sansPhoto) {
      pointsAVerifier.push(`${sansPhoto} réserve(s) sans photographie exploitable dans ce rapport.`);
    }

    // ── Génération ───────────────────────────────────────────────────────
    const perimetre = [
      params.statut ? `statut = ${params.statut}` : null,
      params.batimentId ? 'bâtiment filtré' : null,
      params.phaseId ? 'phase filtrée' : null,
      params.corpsEtatId ? 'corps d’état filtré' : null,
      (params.partenaireId || params.entrepriseId) ? 'entreprise filtrée' : null,
    ].filter(Boolean).join(', ') || 'Toutes les réserves du chantier';

    const buffer = await etapeGeneration(
      'composition-pdf',
      'Le rapport n’a pas pu être composé. Signalez-le au support avec le nom du chantier.',
      { chantierId, type, reserves: reserves.length, photos: nbPhotos },
      () => pdf.construireRapport({
      titre: `Rapport de chantier — ${val(chantier.nom)}`,
      typeLibelle: val(type),
      reference: val(chantier.code, String(chantier.id).slice(0, 8)),
      dateRapport: new Date(),
      auteur: nomUtilisateur(auteur),
      perimetre,
      chantier,
      organisation: chantier.organisation,
      participants,
      entreprises,
      reserves: reservesVue,
      groupes,
      repartitionPhases,
      aTraiter,
      remarques,
      pointsAVerifier,
      nbPhotos,
      }),
    );

    // ── Stockage + historique ────────────────────────────────────────────
    const fichier_url = await etapeGeneration(
      'stockage',
      'Le rapport a été composé mais n’a pas pu être enregistré. Réessayez ; si cela persiste, l’espace de stockage est peut-être saturé.',
      { chantierId, type, taille: buffer.length },
      () => storeFile(
        buffer,
        `rapport-${type}-${chantier.code || chantier.id}.pdf`,
        'rapports',
      ),
    );

    const rapport = await etapeGeneration(
      'enregistrement',
      'Le rapport a été produit mais n’a pas pu être enregistré dans l’historique.',
      { chantierId, type },
      () => Rapport.create({
        chantierId,
        type,
        fichier_url,
        generePar,
        parametres: params,
      }),
    );

    logger.info(
      `[rapport] Généré — chantier ${chantierId}, type ${type}, `
      + `${reserves.length} réserve(s), ${nbPhotos} photo(s), ${buffer.length} octets`,
    );

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
