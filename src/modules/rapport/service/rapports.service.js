'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');

const {
  Rapport, RapportFiltre, RapportHistorique, RapportDestinataire, RapportPartage,
  Chantier, Organisation, Utilisateur, Partenaire, CorpsEtat,
} = require('../../../models/index.js');
const { storeFile, deleteFile, ouvrirFichier } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');

const R = require('./rapportReferentiel.js');
const donnees = require('./rapportDonnees.service.js');
const pdf = require('./rapportPdf.js');
const plansPdf = require('./rapportPlans.js');
const excel = require('./rapportExcel.js');
const medias = require('./rapportMedias.js');

/**
 * SERVICE RAPPORTS — le « véritable service Reports séparé » du § 25 :
 * filtres + modèles + génération + stockage + diffusion + historique.
 *
 * ── Le rapport est une CONFIGURATION avant d'être un fichier ───────────────
 *
 * Le § 3 fait commencer le parcours par le choix d'un modèle, de filtres et
 * de sections ; le § 20 permet de revenir dessus après une prévisualisation.
 * Un rapport naît donc en BROUILLON, sans fichier, et la génération (§ 11)
 * n'est qu'une opération parmi d'autres sur cet objet.
 *
 * ── Ce qui est déjà diffusé ne se réécrit pas ──────────────────────────────
 *
 * « Ne jamais écraser silencieusement l'historique d'un rapport déjà
 * diffusé » (§ 18). Régénérer un rapport ENVOYÉ crée donc une NOUVELLE
 * VERSION — une nouvelle ligne, qui pointe vers la précédente. L'ancienne
 * passe en ARCHIVÉ mais garde son fichier : c'est le document qu'une
 * entreprise a réellement reçu, et une réclamation portera dessus.
 */

/* ══════════════════════════════════════════════════════════════════════════
   Diagnostic : chaque étape porte son nom
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Un schéma de base EN RETARD sur le code — table ou colonne absente.
 *
 * Ce cas mérite son propre message : il ne vient pas des données du chantier
 * mais d'une migration non appliquée, et « vérifiez le chantier » enverrait
 * l'utilisateur chercher un problème qui n'est pas de son côté.
 *
 * On reconnaît le cas au code SQLSTATE de PostgreSQL — 42P01 (table inconnue)
 * et 42703 (colonne inconnue) — plutôt qu'au texte du message, qui change
 * avec la langue du serveur.
 */
function schemaEnRetard(err) {
  const code = err?.parent?.code || err?.original?.code || err?.code;
  return code === '42P01' || code === '42703';
}

/**
 * Exécute une ÉTAPE de la génération en la NOMMANT.
 *
 * Sans cela, la lecture des données, la composition du PDF et l'écriture du
 * fichier partagent le même « Erreur interne du serveur » : l'utilisateur ne
 * sait pas quoi corriger, et le journal ne dit pas où chercher. L'erreur
 * technique part au journal avec son contexte ; l'utilisateur reçoit une
 * phrase qui décrit ce qui a échoué et ce qu'il peut faire.
 */
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

/* ══════════════════════════════════════════════════════════════════════════
   Logos
   ══════════════════════════════════════════════════════════════════════════ */

const CHEMIN_LOGO_WIDJILA = path.join(__dirname, '..', '..', '..', 'assets', 'logo-widjila.png');
let logoWidjilaCache;

/**
 * Le logo Widjila de la couverture (§ 6).
 *
 * Chargé UNE FOIS et réduit : l'original pèse 300 Ko, ce qui alourdirait
 * chaque rapport envoyé par courriel sans rien apporter à 150 points de
 * large. La réduction échoue silencieusement si `sharp` n'est pas disponible
 * — le logo d'origine reste alors utilisable.
 */
async function logoWidjila() {
  if (logoWidjilaCache !== undefined) return logoWidjilaCache;
  try {
    const original = await fs.readFile(CHEMIN_LOGO_WIDJILA);
    try {
      const sharp = require('sharp');
      logoWidjilaCache = await sharp(original).resize({ width: 320 }).png().toBuffer();
    } catch {
      logoWidjilaCache = original;
    }
  } catch {
    logoWidjilaCache = null;
  }
  return logoWidjilaCache;
}

/** Le logo du client, quand son organisation en a déposé un. */
async function logoClient(organisation) {
  if (!organisation?.logo_url) return null;
  const buffer = await medias.chargerBuffer(organisation.logo_url, 3 * 1024 * 1024);
  if (!buffer) return null;
  try {
    const sharp = require('sharp');
    return await sharp(buffer).resize({ width: 260 }).png().toBuffer();
  } catch {
    return buffer;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Utilitaires
   ══════════════════════════════════════════════════════════════════════════ */

/** Nom lisible d'un utilisateur. */
function nomUtilisateur(u) {
  if (!u) return null;
  const complet = [u.prenom, u.nom].filter(Boolean).join(' ').trim();
  return complet || u.email || null;
}

/** Fragment de nom de fichier sûr — pas d'accent, pas d'espace, pas de chemin. */
function fragmentFichier(texte, defaut = 'rapport') {
  const nettoye = String(texte || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return nettoye.slice(0, 40) || defaut;
}

/** Sections normalisées : les cinq clés du § 10, jamais d'autres. */
function normaliserSections(brut, defauts = R.SECTIONS_PAR_DEFAUT) {
  const sections = { ...defauts };
  if (brut && typeof brut === 'object') {
    for (const cle of R.SECTIONS) {
      if (brut[cle] !== undefined) sections[cle] = Boolean(brut[cle]);
    }
  }
  return sections;
}

/** Formats normalisés : PDF, XLSX, ou les deux — jamais aucun. */
function normaliserFormats(brut) {
  const liste = Array.isArray(brut) ? brut : (brut ? [brut] : []);
  const formats = liste
    .map((f) => String(f).trim().toUpperCase())
    // « Excel » est le mot du § 4 ; « XLSX » celui du § 10. Même format.
    .map((f) => (f === 'EXCEL' ? 'XLSX' : f))
    .filter((f) => R.FORMATS.includes(f));
  const uniques = [...new Set(formats)];
  // Un rapport sans aucun format ne produirait rien : le PDF est le format de
  // référence du cahier des charges, il sert de repli.
  return uniques.length ? uniques : ['PDF'];
}

/**
 * Vérifie les filtres exigés par le modèle (§ 5).
 *
 * Un « rapport par bâtiment » sans bâtiment n'est pas un rapport par
 * bâtiment : c'est un rapport global qui en porte le titre, et il partirait
 * aux entreprises sous ce nom.
 */
function verifierFiltresRequis(modeleDef, filtres) {
  const manquants = [];
  for (const exigence of modeleDef.filtresRequis || []) {
    switch (exigence) {
      case 'batiment':
        if (!filtres.batiments.length) manquants.push('un bâtiment');
        break;
      case 'etage_ou_zone':
        if (!filtres.etages.length && !filtres.zones.length) manquants.push('un étage ou une zone');
        break;
      case 'entreprise':
        if (!filtres.entreprises.length) manquants.push('une entreprise');
        break;
      case 'corps_etat':
        if (!filtres.corpsEtat.length) manquants.push('un corps d’état');
        break;
      default:
        break;
    }
  }
  return manquants;
}

class RapportsService {

  /* ════════════════════════════════════════════════════════════════════════
     Lecture
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Charge un rapport EN VÉRIFIANT qu'il appartient bien à l'organisation.
   *
   * Le § 21 l'exige explicitement : « protection contre l'accès à un autre
   * chantier par modification d'identifiant ». Le cloisonnement passe par le
   * chantier, seul porteur de l'organisation.
   */
  static async _charger(rapportId, organisationId, options = {}) {
    return Rapport.findOne({
      where: { id: rapportId },
      include: [
        {
          model: Chantier, as: 'chantier', required: true,
          where: { organisationId },
          attributes: ['id', 'nom', 'code', 'adresse', 'statut', 'date_debut', 'date_fin', 'organisationId'],
          include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom', 'logo_url'], required: false }],
        },
        ...(options.include || []),
      ],
    });
  }

  /** Écrit une ligne d'historique (§ 18) — jamais de mise à jour, que des ajouts. */
  static async _journaliser(rapportId, action, acteurId = null, metadata = null, transaction = null) {
    try {
      return await RapportHistorique.create(
        { rapportId, action, acteurId, metadata },
        transaction ? { transaction } : undefined,
      );
    } catch (err) {
      // Un historique qui échoue ne doit pas annuler l'action réussie ; il est
      // journalisé côté serveur pour être rattrapable.
      logger.error(`[rapport] Historique non écrit (${rapportId}, ${action}) : ${err.message}`);
      return null;
    }
  }

  /**
   * Réécrit les lignes de REPORT_FILTER à partir des filtres canoniques.
   *
   * Une ligne par valeur retenue — voir l'en-tête de `rapportFiltre.model.js`.
   */
  static async _ecrireFiltres(rapportId, filtres, transaction = null) {
    const options = transaction ? { transaction } : undefined;
    await RapportFiltre.destroy({ where: { rapportId }, ...(options || {}) });

    const lignes = [];
    const ajouter = (champ, valeurs) => {
      for (const valeur of valeurs) lignes.push({ rapportId, [champ]: valeur });
    };

    ajouter('batimentId', filtres.batiments);
    ajouter('etageId', filtres.etages);
    ajouter('zoneId', filtres.zones);
    ajouter('partenaireId', filtres.entreprises);
    ajouter('corpsEtatId', filtres.corpsEtat);
    ajouter('statut', filtres.statuts);
    ajouter('gravite', filtres.gravites);
    if (filtres.dateDebut || filtres.dateFin) {
      lignes.push({ rapportId, date_debut: filtres.dateDebut, date_fin: filtres.dateFin });
    }

    if (lignes.length) await RapportFiltre.bulkCreate(lignes, options);
    return lignes.length;
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 9 — POST /reports : créer la configuration
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Crée un rapport en BROUILLON (§ 11, étape 1).
   *
   * Rien n'est généré ici : le § 3 veut que l'utilisateur puisse prévisualiser
   * avant de produire quoi que ce soit, et le § 20 qu'il revienne sur ses
   * filtres ensuite.
   */
  static async creer(params, utilisateur, organisationId) {
    const chantier = await Chantier.findOne({
      where: { id: params.chantierId, organisationId },
      attributes: ['id', 'nom', 'code'],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const modeleDef = R.modele(params.modele);
    if (!modeleDef) {
      const attendu = R.MODELES_VERSION_ULTERIEURE[String(params.modele || '').toUpperCase()];
      return {
        success: false,
        message: attendu
          ? `${attendu} : prévu dans une version ultérieure.`
          : `Modèle de rapport inconnu. Modèles disponibles : ${R.CODES_MODELE.join(', ')}.`,
      };
    }

    const resolution = await donnees.resoudreFiltres(chantier.id, params.filtres);
    const filtres = donnees.appliquerDefautsModele(resolution.filtres, modeleDef);

    const inconnus = Object.values(resolution.inconnus).flat();
    if (inconnus.length) {
      return {
        success: false,
        message: `Ces éléments n’appartiennent pas à ce chantier : ${inconnus.join(', ')}.`,
      };
    }

    const manquants = verifierFiltresRequis(modeleDef, filtres);
    if (manquants.length) {
      return {
        success: false,
        message: `Le modèle « ${modeleDef.libelle} » demande de choisir ${manquants.join(' et ')}.`,
      };
    }

    const sections = normaliserSections(params.sections, modeleDef.sectionsParDefaut);
    const formats = normaliserFormats(params.formats);

    const rapport = await Rapport.create({
      chantierId: chantier.id,
      // L'ancien champ reste renseigné : les écrans déjà déployés le lisent.
      type: R.MODELE_VERS_TYPE_LEGACY[modeleDef.id] || 'reserves',
      nom: params.nom?.trim() || modeleDef.libelle,
      modele: modeleDef.id,
      statut: R.ETATS.BROUILLON,
      sections,
      filtres,
      formats,
      version: 1,
      generePar: utilisateur?.id || null,
      partenaireId: filtres.entreprises.length === 1 ? filtres.entreprises[0] : null,
      parametres: params.filtres || null,
    });

    await RapportsService._ecrireFiltres(rapport.id, filtres);
    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.CREE, utilisateur?.id, {
      modele: modeleDef.id,
      nom: rapport.nom,
    });

    return { success: true, rapport };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 9 — PATCH /reports/{id} : revenir sur la configuration (§ 20)
     ════════════════════════════════════════════════════════════════════════ */

  static async modifier(rapportId, patch, utilisateur, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    // Un rapport DIFFUSÉ ne se modifie pas : le document reçu par une
    // entreprise doit rester exactement ce qu'elle a reçu (§ 18). La suite
    // passe par une nouvelle version ou par une duplication, deux gestes
    // explicites qui laissent une trace.
    if (rapport.statut === R.ETATS.ENVOYE) {
      return {
        success: false,
        message: 'Ce rapport a déjà été diffusé : dupliquez-le ou générez une nouvelle version pour le modifier.',
      };
    }

    const modeleDef = patch.modele ? R.modele(patch.modele) : R.modele(rapport.modele) || R.MODELES.GLOBAL;
    if (patch.modele && !modeleDef) {
      return { success: false, message: `Modèle de rapport inconnu : ${patch.modele}.` };
    }

    const misAJour = {};
    if (patch.nom !== undefined) misAJour.nom = String(patch.nom).trim() || modeleDef.libelle;
    if (patch.modele !== undefined) {
      misAJour.modele = modeleDef.id;
      misAJour.type = R.MODELE_VERS_TYPE_LEGACY[modeleDef.id] || 'reserves';
    }
    if (patch.sections !== undefined) {
      misAJour.sections = normaliserSections(patch.sections, rapport.sections || modeleDef.sectionsParDefaut);
    }
    if (patch.formats !== undefined) misAJour.formats = normaliserFormats(patch.formats);

    let filtres = null;
    if (patch.filtres !== undefined || patch.modele !== undefined) {
      const source = patch.filtres !== undefined ? patch.filtres : rapport.filtres;
      const resolution = await donnees.resoudreFiltres(rapport.chantierId, source);
      filtres = donnees.appliquerDefautsModele(resolution.filtres, modeleDef);

      const inconnus = Object.values(resolution.inconnus).flat();
      if (inconnus.length) {
        return { success: false, message: `Ces éléments n’appartiennent pas à ce chantier : ${inconnus.join(', ')}.` };
      }
      const manquants = verifierFiltresRequis(modeleDef, filtres);
      if (manquants.length) {
        return {
          success: false,
          message: `Le modèle « ${modeleDef.libelle} » demande de choisir ${manquants.join(' et ')}.`,
        };
      }
      misAJour.filtres = filtres;
      misAJour.partenaireId = filtres.entreprises.length === 1 ? filtres.entreprises[0] : null;
    }

    await rapport.update(misAJour);
    if (filtres) await RapportsService._ecrireFiltres(rapport.id, filtres);

    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.MODIFIE, utilisateur?.id, {
      champs: Object.keys(misAJour),
    });

    return { success: true, rapport };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 11 — La génération, en douze étapes
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Rassemble tout ce que les générateurs consomment (§ 11, étapes 3 à 8).
   *
   * Séparé de `generer()` pour être réutilisable tel quel par la
   * PRÉVISUALISATION (§ 20), qui doit montrer exactement le document qui
   * sortira — sinon la prévisualisation ne prouve rien.
   */
  static async _assembler(rapport, { previsualisation = false } = {}) {
    const chantier = rapport.chantier;
    const modeleDef = R.modele(rapport.modele) || R.MODELES.GLOBAL;
    const sections = normaliserSections(rapport.sections, modeleDef.sectionsParDefaut);

    const resolution = await donnees.resoudreFiltres(chantier.id, rapport.filtres || {});
    const filtres = donnees.appliquerDefautsModele(resolution.filtres, modeleDef);

    const [auteur, entreprises, corpsEtat, logos] = await Promise.all([
      rapport.generePar
        ? Utilisateur.findByPk(rapport.generePar, { attributes: ['id', 'nom', 'prenom', 'email'] })
        : null,
      filtres.entreprises.length
        ? Partenaire.findAll({ where: { id: { [Op.in]: filtres.entreprises } }, attributes: ['id', 'nom'] })
        : [],
      filtres.corpsEtat.length
        ? CorpsEtat.findAll({ where: { id: { [Op.in]: filtres.corpsEtat } }, attributes: ['id', 'nom'] })
        : [],
      Promise.all([logoWidjila(), logoClient(chantier.organisation)]),
    ]);

    const vue = await donnees.chargerVue({
      chantier,
      organisation: chantier.organisation,
      filtres,
      modeleDef,
      sections,
      auteur: nomUtilisateur(auteur),
      structure: resolution.structure,
      rapport,
    });

    return {
      ...vue,
      titre: rapport.nom || modeleDef.libelle,
      modeleLibelle: modeleDef.libelle,
      reference: chantier.code || String(chantier.id).slice(0, 8),
      version: rapport.version,
      previsualisation,
      logos: { widjila: logos[0], client: logos[1] },
      perimetre: RapportsService._perimetreLisible(filtres, {
        structure: resolution.structure,
        entreprises,
        corpsEtat,
      }),
    };
  }

  /**
   * Le périmètre EN TOUTES LETTRES — pour la couverture et l'annexe.
   *
   * Un rapport dont on ne peut pas lire le périmètre est ininterprétable :
   * « 12 réserves » ne veut rien dire tant qu'on ne sait pas 12 réserves de
   * quoi, où, et sur quelle période.
   */
  static _perimetreLisible(filtres, { structure, entreprises = [], corpsEtat = [] }) {
    const nomsDe = (ids, index) => ids
      .map((id) => index?.get(String(id)))
      .filter(Boolean)
      .map((e) => e.nom);

    const localisation = [
      ...nomsDe(filtres.batiments, structure?.parBatiment),
      ...nomsDe(filtres.etages, structure?.parEtage),
      ...nomsDe(filtres.zones, structure?.parZone),
    ].join(', ');

    const periode = (() => {
      if (filtres.dateDebut && filtres.dateFin) {
        // Pas de flèche : les polices standard du PDF n'en ont pas.
        return `Du ${pdf.dateFr(filtres.dateDebut)} au ${pdf.dateFr(filtres.dateFin)}`;
      }
      if (filtres.dateDebut) return `À partir du ${pdf.dateFr(filtres.dateDebut)}`;
      if (filtres.dateFin) return `Jusqu’au ${pdf.dateFr(filtres.dateFin)}`;
      return null;
    })();

    return {
      localisation: localisation || null,
      entreprises: entreprises.map((e) => e.nom).join(', ') || null,
      corpsEtat: corpsEtat.map((c) => c.nom).join(', ') || null,
      statuts: filtres.statuts.map((s) => R.libelleStatutRapport(s)).join(', ') || null,
      gravites: filtres.gravites.map((g) => R.libelleGravite(g)).join(', ') || null,
      periode,
      filtres,
    };
  }

  /** Compose les fichiers demandés à partir de la vue assemblée. */
  static async _composer(vue, formats, contexte) {
    const fichiers = {};

    if (formats.includes('PDF')) {
      const compose = await etapeGeneration(
        'composition-pdf',
        'Le rapport n’a pas pu être composé. Signalez-le au support avec le nom du chantier.',
        contexte,
        () => pdf.construireRapport(vue),
      );

      // L'incrustation des plans ne peut pas faire échouer le rapport : elle
      // enrichit le document, elle ne le conditionne pas.
      let buffer = compose.buffer;
      if (compose.emplacements.length) {
        try {
          buffer = await plansPdf.incrusterPlans(
            compose.buffer, compose.emplacements, vue.plans, pdf.HAUTEUR_PAGE,
          );
        } catch (err) {
          logger.warn(`[rapport] Plans non incrustés : ${err.message}`);
        }
      }
      fichiers.pdf = buffer;
    }

    if (formats.includes('XLSX')) {
      fichiers.xlsx = await etapeGeneration(
        'composition-excel',
        'Le fichier Excel n’a pas pu être produit. Réessayez, ou demandez le format PDF seul.',
        contexte,
        () => excel.construireExcel(vue),
      );
    }

    return fichiers;
  }

  /**
   * Génère le rapport — les douze étapes du § 11.
   *
   * 1-2. la configuration et les droits ont été vérifiés en amont (route +
   *      cloisonnement par l'organisation) ;
   * 3-6. lecture des réserves, plans, photos, entreprises ;
   * 7-8. synthèse et fiches ;
   * 9.   PDF et/ou Excel ;
   * 10.  stockage privé ;
   * 11.  historique ;
   * 12.  identifiant du rapport et URL sécurisée (rendus par le contrôleur).
   */
  static async generer(rapportId, utilisateur, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    // § 18 — un rapport déjà diffusé n'est jamais réécrit : on produit une
    // nouvelle version, et l'ancienne reste telle qu'elle a été envoyée.
    let cible = rapport;
    let nouvelleVersion = false;
    if (rapport.statut === R.ETATS.ENVOYE) {
      cible = await RapportsService._creerVersionSuivante(rapport, utilisateur);
      nouvelleVersion = true;
    }

    const contexte = { rapport: cible.id, chantier: cible.chantierId, modele: cible.modele };
    const formats = normaliserFormats(cible.formats);
    const ancienPdf = cible.fichier_url;
    const ancienXlsx = cible.fichier_xlsx_url;

    await cible.update({ statut: R.ETATS.GENERATION, erreur: null });

    try {
      const vue = await etapeGeneration(
        'lecture-donnees',
        'Impossible de lire les données du chantier. Vérifiez le chantier et réessayez.',
        contexte,
        () => RapportsService._assembler(cible),
      );

      const fichiers = await RapportsService._composer(vue, formats, {
        ...contexte, reserves: vue.reserves.length, photos: vue.nbPhotos,
      });

      const base = `rapport-${fragmentFichier(cible.modele)}-${fragmentFichier(cible.chantier.code || cible.chantierId)}-v${cible.version}`;
      const stocke = await etapeGeneration(
        'stockage',
        'Le rapport a été composé mais n’a pas pu être enregistré. Réessayez ; si cela persiste, l’espace de stockage est peut-être saturé.',
        { ...contexte, taille: fichiers.pdf?.length || 0 },
        async () => ({
          pdf: fichiers.pdf ? await storeFile(fichiers.pdf, `${base}.pdf`, 'rapports') : null,
          xlsx: fichiers.xlsx ? await storeFile(fichiers.xlsx, `${base}.xlsx`, 'rapports') : null,
        }),
      );

      await etapeGeneration(
        'enregistrement',
        'Le rapport a été produit mais n’a pas pu être enregistré dans l’historique.',
        contexte,
        () => cible.update({
          statut: R.ETATS.GENERE,
          fichier_url: stocke.pdf || cible.fichier_url,
          fichier_xlsx_url: stocke.xlsx,
          genere_le: new Date(),
          taille_pdf: fichiers.pdf?.length || null,
          nb_reserves: vue.reserves.length,
          erreur: null,
          generePar: utilisateur?.id || cible.generePar,
        }),
      );

      await RapportsService._journaliser(
        cible.id,
        nouvelleVersion ? R.ACTIONS_HISTORIQUE.NOUVELLE_VERSION : R.ACTIONS_HISTORIQUE.GENERE,
        utilisateur?.id,
        {
          version: cible.version,
          reserves: vue.reserves.length,
          photos: vue.nbPhotos,
          formats,
          taille: fichiers.pdf?.length || null,
        },
      );

      // Les fichiers de la génération précédente ne servent plus : le rapport
      // n'avait pas été diffusé, personne ne détient leur URL.
      if (!nouvelleVersion) {
        if (ancienPdf && stocke.pdf && ancienPdf !== stocke.pdf) deleteFile(ancienPdf).catch(() => {});
        if (ancienXlsx && ancienXlsx !== stocke.xlsx) deleteFile(ancienXlsx).catch(() => {});
      }

      logger.info(
        `[rapport] Généré — rapport ${cible.id}, chantier ${cible.chantierId}, modèle ${cible.modele}, `
        + `${vue.reserves.length} réserve(s), ${vue.nbPhotos} photo(s), version ${cible.version}`,
      );

      return { success: true, rapport: cible, nouvelleVersion, resume: RapportsService._resumeVue(vue) };
    } catch (err) {
      // L'ÉCHEC EST UN ÉTAT (§ 19), pas un silence : le rapport reste dans la
      // liste, avec son motif, et peut être relancé.
      await cible.update({ statut: R.ETATS.ECHEC, erreur: err.message }).catch(() => {});
      await RapportsService._journaliser(cible.id, R.ACTIONS_HISTORIQUE.ECHEC, utilisateur?.id, {
        etape: err.etapeRapport || null, message: err.message,
      });
      throw err;
    }
  }

  /** Duplique la configuration dans une NOUVELLE version (§ 18). */
  static async _creerVersionSuivante(rapport, utilisateur) {
    const suivant = await Rapport.create({
      chantierId: rapport.chantierId,
      type: rapport.type,
      nom: rapport.nom,
      modele: rapport.modele,
      statut: R.ETATS.EN_ATTENTE,
      sections: rapport.sections,
      filtres: rapport.filtres,
      formats: rapport.formats,
      version: (rapport.version || 1) + 1,
      rapportParentId: rapport.id,
      generePar: utilisateur?.id || rapport.generePar,
      partenaireId: rapport.partenaireId,
      lotGenerationId: rapport.lotGenerationId,
      parametres: rapport.parametres,
    });

    // L'ancienne version reste lisible, avec son fichier : c'est le document
    // que l'entreprise a reçu.
    await rapport.update({ statut: R.ETATS.ARCHIVE });
    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.ARCHIVE, utilisateur?.id, {
      remplacePar: suivant.id, version: suivant.version,
    });

    const filtres = donnees.normaliserFiltres(rapport.filtres || {});
    await RapportsService._ecrireFiltres(suivant.id, filtres);
    await RapportsService._journaliser(suivant.id, R.ACTIONS_HISTORIQUE.CREE, utilisateur?.id, {
      versionPrecedente: rapport.id, version: suivant.version,
    });

    suivant.chantier = rapport.chantier;
    return suivant;
  }

  /** Ce que la génération renvoie à l'écran : de quoi annoncer le résultat. */
  static _resumeVue(vue) {
    return {
      reserves: vue.reserves.length,
      photos: vue.nbPhotos,
      photosIgnorees: vue.nbPhotosIgnorees,
      parStatut: vue.synthese.parStatut,
      parGravite: vue.synthese.parGravite,
      entreprises: vue.synthese.parEntreprise.length,
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 20 — Prévisualisation
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Produit le PDF de prévisualisation SANS rien stocker.
   *
   * Le document porte un filigrane : une prévisualisation n'a ni numéro de
   * version ni trace d'envoi, et rien ne doit permettre de la faire passer
   * pour le rapport officiel une fois transférée.
   */
  static async previsualiser(rapportId, organisationId, utilisateur) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const vue = await etapeGeneration(
      'lecture-donnees',
      'Impossible de lire les données du chantier. Vérifiez le chantier et réessayez.',
      { rapport: rapport.id, chantier: rapport.chantierId },
      () => RapportsService._assembler(rapport, { previsualisation: true }),
    );

    const compose = await etapeGeneration(
      'composition-pdf',
      'La prévisualisation n’a pas pu être composée.',
      { rapport: rapport.id, reserves: vue.reserves.length },
      () => pdf.construireRapport(vue),
    );

    let buffer = compose.buffer;
    if (compose.emplacements.length) {
      try {
        buffer = await plansPdf.incrusterPlans(compose.buffer, compose.emplacements, vue.plans, pdf.HAUTEUR_PAGE);
      } catch { /* la prévisualisation vaut mieux sans plans que pas du tout */ }
    }

    return {
      success: true,
      buffer,
      nom: `previsualisation-${fragmentFichier(rapport.nom || rapport.modele)}.pdf`,
      resume: RapportsService._resumeVue(vue),
      rapport,
      utilisateurId: utilisateur?.id || null,
    };
  }

  /**
   * Le RÉSUMÉ chiffré du périmètre, sans produire de document.
   *
   * C'est ce que l'écran mobile affiche avant de lancer une génération qui
   * peut durer : « 142 réserves, 3 entreprises ». Sans lui, l'utilisateur
   * découvrirait un rapport vide après trente secondes d'attente.
   */
  static async resume(rapportId, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const modeleDef = R.modele(rapport.modele) || R.MODELES.GLOBAL;
    const resolution = await donnees.resoudreFiltres(rapport.chantierId, rapport.filtres || {});
    const filtres = donnees.appliquerDefautsModele(resolution.filtres, modeleDef);

    // Les photos et les plans ne sont PAS chargés : le résumé doit être
    // instantané, c'est toute sa raison d'être.
    const vue = await donnees.chargerVue({
      chantier: rapport.chantier,
      organisation: rapport.chantier.organisation,
      filtres,
      modeleDef,
      sections: { summary: true, plans: false, photos: false, location: false, history: false },
      structure: resolution.structure,
      rapport,
    });

    return {
      success: true,
      resume: {
        ...RapportsService._resumeVue(vue),
        parEntreprise: vue.synthese.parEntreprise,
        total: vue.synthese.total,
      },
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 15 — Un rapport par entreprise
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * « Générer les rapports par entreprise ».
   *
   * Les réserves du périmètre sont regroupées par entreprise, et CHAQUE
   * entreprise reçoit son propre document. Le § 15 en donne la raison, qui
   * est la seule qui compte : « cela évite d'envoyer à un sous-traitant les
   * réserves d'une autre société ».
   *
   * Les réserves sans entreprise identifiée ne disparaissent pas en silence :
   * leur nombre est renvoyé, pour que quelqu'un puisse les rattacher.
   */
  static async genererParEntreprise(rapportId, utilisateur, organisationId) {
    const source = await RapportsService._charger(rapportId, organisationId);
    if (!source) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const resume = await RapportsService.resume(rapportId, organisationId);
    if (!resume.success) return resume;

    const parEntreprise = resume.resume.parEntreprise.filter((e) => e.entreprise !== 'Sans entreprise identifiée');
    const sansEntreprise = resume.resume.parEntreprise
      .filter((e) => e.entreprise === 'Sans entreprise identifiée')
      .reduce((total, e) => total + e.total, 0);

    if (!parEntreprise.length) {
      return {
        success: false,
        message: sansEntreprise
          ? `Aucune réserve de ce périmètre n’est rattachée à une entreprise (${sansEntreprise} réserve(s) sans entreprise).`
          : 'Aucune réserve dans le périmètre de ce rapport.',
      };
    }

    // Les identifiants d'entreprise viennent des réserves elles-mêmes : c'est
    // le regroupement par `company_id` du § 15.
    const partenaires = await Partenaire.findAll({
      where: { chantierId: source.chantierId },
      attributes: ['id', 'nom', 'email', 'contact'],
    });
    const parNom = new Map(partenaires.map((p) => [p.nom, p]));

    const lot = crypto.randomUUID();
    const produits = [];
    const echecs = [];

    for (const ligne of parEntreprise) {
      const partenaire = parNom.get(ligne.entreprise);
      if (!partenaire) continue;

      const creation = await RapportsService.creer({
        chantierId: source.chantierId,
        nom: `${source.nom || 'Rapport'} — ${partenaire.nom}`,
        modele: source.modele,
        sections: source.sections,
        formats: source.formats,
        filtres: { ...(source.filtres || {}), entreprises: [partenaire.id] },
      }, utilisateur, organisationId);

      if (!creation.success) {
        echecs.push({ entreprise: partenaire.nom, message: creation.message });
        continue;
      }

      await creation.rapport.update({ lotGenerationId: lot, partenaireId: partenaire.id });

      try {
        const generation = await RapportsService.generer(creation.rapport.id, utilisateur, organisationId);
        if (generation.success) produits.push(generation.rapport);
        else echecs.push({ entreprise: partenaire.nom, message: generation.message });
      } catch (err) {
        // Une entreprise dont le rapport échoue ne doit pas empêcher les neuf
        // autres de partir.
        echecs.push({ entreprise: partenaire.nom, message: err.message });
      }
    }

    logger.info(
      `[rapport] Lot par entreprise ${lot} — ${produits.length} rapport(s) produit(s), ${echecs.length} échec(s)`,
    );

    return {
      success: produits.length > 0,
      message: produits.length
        ? `${produits.length} rapport(s) généré(s), un par entreprise.`
        : 'Aucun rapport n’a pu être généré.',
      lot,
      rapports: produits,
      echecs,
      reservesSansEntreprise: sansEntreprise,
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 9 — Lecture, duplication, archivage
     ════════════════════════════════════════════════════════════════════════ */

  static async lister(organisationId, filtres = {}, auteur = null) {
    // Même visibilité que la liste des chantiers (require local : dépendance
    // circulaire possible entre services).
    // eslint-disable-next-line global-require
    const cloisonnement = require('../../chantier/service/chantier.service.js').filtreCloisonnement(auteur);
    const where = {};
    if (filtres.chantierId) where.chantierId = filtres.chantierId;
    if (filtres.statut) where.statut = filtres.statut;
    if (filtres.modele) where.modele = String(filtres.modele).toUpperCase();
    if (filtres.lot) where.lotGenerationId = filtres.lot;

    const limit = Math.min(Math.max(Number(filtres.limit) || 50, 1), 200);
    const offset = Math.max((Number(filtres.page) || 1) - 1, 0) * limit;

    const resultat = await Rapport.findAndCountAll({
      where,
      include: [{
        model: Chantier, as: 'chantier', required: true,
        where: { organisationId, ...(cloisonnement || {}) },
        attributes: ['id', 'nom', 'code'],
      }, {
        model: Partenaire, as: 'entrepriseCible', required: false, attributes: ['id', 'nom'],
      }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });

    return { success: true, rapports: resultat.rows, total: resultat.count, page: Number(filtres.page) || 1, limit };
  }

  static async detail(rapportId, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId, {
      include: [
        { model: Utilisateur, as: 'generateur', attributes: ['id', 'nom', 'prenom', 'email'], required: false },
        { model: Partenaire, as: 'entrepriseCible', attributes: ['id', 'nom', 'email'], required: false },
        { model: RapportDestinataire, as: 'destinataires', required: false },
        {
          model: RapportPartage, as: 'partages', required: false,
          attributes: ['id', 'expire_le', 'revoque_le', 'nb_acces', 'dernier_acces_le', 'authentification_requise', 'createdAt'],
        },
      ],
    });
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };
    return { success: true, rapport };
  }

  /** § 9 — GET /reports/{id}/history. */
  static async historique(rapportId, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const lignes = await RapportHistorique.findAll({
      where: { rapportId },
      include: [{ model: Utilisateur, as: 'acteur', attributes: ['id', 'nom', 'prenom', 'email'], required: false }],
      order: [['createdAt', 'ASC']],
    });

    return {
      success: true,
      historique: lignes.map((l) => ({
        id: l.id,
        action: l.action,
        libelle: R.LIBELLE_ACTION[l.action] || l.action,
        acteur: nomUtilisateur(l.acteur),
        metadata: l.metadata || null,
        date: l.createdAt,
      })),
    };
  }

  /** § 9 — POST /reports/{id}/duplicate. */
  static async dupliquer(rapportId, utilisateur, organisationId) {
    const source = await RapportsService._charger(rapportId, organisationId);
    if (!source) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const copie = await Rapport.create({
      chantierId: source.chantierId,
      type: source.type,
      nom: `${source.nom || 'Rapport'} (copie)`,
      modele: source.modele,
      // Une copie repart en BROUILLON : elle n'a ni fichier, ni destinataire,
      // ni historique de diffusion, et c'est exactement ce qu'on attend d'une
      // configuration réutilisée le mois suivant.
      statut: R.ETATS.BROUILLON,
      sections: source.sections,
      filtres: source.filtres,
      formats: source.formats,
      version: 1,
      generePar: utilisateur?.id || null,
      partenaireId: source.partenaireId,
      parametres: source.parametres,
    });

    await RapportsService._ecrireFiltres(copie.id, donnees.normaliserFiltres(source.filtres || {}));
    await RapportsService._journaliser(copie.id, R.ACTIONS_HISTORIQUE.CREE, utilisateur?.id, {
      duplicateDe: source.id,
    });
    await RapportsService._journaliser(source.id, R.ACTIONS_HISTORIQUE.DUPLIQUE, utilisateur?.id, {
      copie: copie.id,
    });

    return { success: true, rapport: copie };
  }

  static async archiver(rapportId, utilisateur, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    await rapport.update({ statut: R.ETATS.ARCHIVE });
    await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.ARCHIVE, utilisateur?.id);
    return { success: true, rapport };
  }

  static async supprimer(rapportId, utilisateur, organisationId) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    await rapport.destroy(); // suppression logique — l'historique reste
    logger.info(`[rapport] Supprimé — ${rapportId} par ${utilisateur?.id || 'inconnu'}`);
    return { success: true, message: 'Rapport supprimé' };
  }

  /* ════════════════════════════════════════════════════════════════════════
     § 9 — GET /reports/{id}/download
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Ouvre le fichier d'un rapport pour le servir.
   *
   * Le téléchargement est JOURNALISÉ : le § 18 range « rapport consulté »
   * parmi les événements à tracer, et c'est ce qui permet de répondre à « qui
   * a récupéré ce document ».
   */
  static async fichier(rapportId, organisationId, { format = 'pdf', utilisateurId = null, journaliser = true } = {}) {
    const rapport = await RapportsService._charger(rapportId, organisationId);
    if (!rapport) return { success: false, message: 'Rapport introuvable dans cette organisation' };

    const estExcel = String(format).toLowerCase() === 'xlsx';
    const reference = estExcel ? rapport.fichier_xlsx_url : rapport.fichier_url;

    if (!reference) {
      return {
        success: false,
        message: estExcel
          ? 'Ce rapport n’a pas de version Excel. Ajoutez le format XLSX puis régénérez-le.'
          : 'Ce rapport n’a pas encore été généré.',
      };
    }

    const fichier = await ouvrirFichier(reference);
    if (!fichier || !fichier.stream) {
      return { success: false, message: 'Le fichier du rapport est introuvable. Générez-le à nouveau.' };
    }

    if (journaliser) {
      await RapportsService._journaliser(rapport.id, R.ACTIONS_HISTORIQUE.TELECHARGE, utilisateurId, { format });
    }

    const base = `${fragmentFichier(rapport.nom || rapport.modele)}-${fragmentFichier(rapport.chantier.code || '')}-v${rapport.version}`;
    return {
      success: true,
      rapport,
      stream: fichier.stream,
      taille: fichier.taille,
      nom: `${base}.${estExcel ? 'xlsx' : 'pdf'}`,
      contentType: estExcel
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf',
    };
  }

  /** Les modèles proposés à l'écran (§ 5). */
  static modeles() {
    return R.CODES_MODELE.map((code) => {
      const m = R.MODELES[code];
      return {
        id: m.id,
        libelle: m.libelle,
        description: m.description,
        filtresRequis: m.filtresRequis,
        sectionsParDefaut: m.sectionsParDefaut,
        filtresParDefaut: m.filtresParDefaut,
      };
    });
  }
}

module.exports = RapportsService;
module.exports._interne = {
  etapeGeneration,
  schemaEnRetard,
  normaliserSections,
  normaliserFormats,
  verifierFiltresRequis,
  fragmentFichier,
  logoWidjila,
  nomUtilisateur,
};
