'use strict';

const { Op } = require('sequelize');
const {
  Reserve, Batiment, Etage, Zone, Plan, Lot, Partenaire, Organisation,
  CorpsEtat, Phase, Media, ReservePosition, ReserveHistorique, Utilisateur,
} = require('../../../models/index.js');
const medias = require('./rapportMedias.js');
const R = require('./rapportReferentiel.js');

/**
 * Les DONNÉES d'un rapport — filtres (§ 4), lecture (§ 11, étapes 3 à 6) et
 * mise en forme (§ 11, étapes 7 et 8).
 *
 * Ce module ne sait ni composer un PDF ni envoyer un courriel : il produit
 * l'objet que le générateur PDF et le générateur Excel consomment tous les
 * deux. C'est ce qui garantit qu'ils racontent la MÊME chose — un total de
 * synthèse calculé deux fois finit toujours par diverger.
 *
 * ── La règle qui commande tout le reste (§ 25) ─────────────────────────────
 *
 * « Les réserves sont les données sources. Le rapport est une vue filtrée,
 * figée et mise en forme de ces données. » Rien n'est donc inventé ici :
 * chaque chiffre de la synthèse est un comptage sur les réserves réellement
 * lues, et chaque donnée absente reste absente.
 */

/** Une chaîne qui ressemble à un identifiant technique. */
const EST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filtres canoniques — la forme unique dans laquelle tout est traduit. */
function filtresVides() {
  return {
    batiments: [],
    etages: [],
    zones: [],
    entreprises: [],
    corpsEtat: [],
    statuts: [],
    gravites: [],
    dateDebut: null,
    dateFin: null,
    // Échappatoires de l'ANCIEN point d'entrée, que les clients déjà installés
    // envoient encore :
    //  - un statut de réserve brut (`en_retard`, `a_verifier`…) — le traduire
    //    en statut de rapport élargirait leur filtre à leur insu ;
    //  - une organisation « entreprise » (`reserves.entreprise_id`), distincte
    //    de l'entreprise de l'annuaire du chantier ;
    //  - une phase.
    statutsReserve: [],
    organisationsEntreprise: [],
    phases: [],
  };
}

/** Première valeur non vide parmi plusieurs clés possibles. */
function premiere(source, cles) {
  for (const cle of cles) {
    const valeur = source[cle];
    if (valeur !== undefined && valeur !== null && valeur !== '') return valeur;
  }
  return undefined;
}

/** Normalise une valeur ou un tableau de valeurs en liste de chaînes propres. */
function liste(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return [];
  const brut = Array.isArray(valeur) ? valeur : [valeur];
  const sortie = [];
  for (const v of brut) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s && !sortie.includes(s)) sortie.push(s);
  }
  return sortie;
}

/** Une date `YYYY-MM-DD` exploitable, ou `null`. */
function dateSeule(valeur) {
  if (!valeur) return null;
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Traduit les filtres reçus vers la forme canonique.
 *
 * ── Pourquoi accepter plusieurs orthographes ───────────────────────────────
 *
 * Le cahier des charges écrit les filtres en anglais (`building_id`,
 * `company_id`, `statuses`, § 10) ; l'application, elle, parle français
 * (`batimentId`, `partenaireId`). Les deux arrivent réellement : le § 10 est
 * le contrat annoncé au client, et les écrans existants envoient déjà l'autre.
 * Refuser l'une des deux formes reviendrait à casser un contrat pour honorer
 * l'autre.
 */
function normaliserFiltres(brut = {}) {
  const source = brut && typeof brut === 'object' ? brut : {};
  const filtres = filtresVides();

  filtres.batiments = liste(premiere(source, [
    'batiments', 'batimentIds', 'batimentId', 'batiment', 'building_ids', 'building_id', 'buildings',
  ]));
  filtres.etages = liste(premiere(source, [
    'etages', 'etageIds', 'etageId', 'etage', 'niveaux', 'niveau',
    'level_ids', 'level_id', 'levels',
  ]));
  filtres.zones = liste(premiere(source, [
    'zones', 'zoneIds', 'zoneId', 'zone', 'appartements', 'appartement',
    'zone_ids', 'zone_id', 'apartments',
  ]));
  filtres.entreprises = liste(premiere(source, [
    'entreprises', 'partenaireIds', 'partenaireId', 'entreprise',
    'company_ids', 'company_id', 'companies',
  ]));
  filtres.corpsEtat = liste(premiere(source, [
    'corpsEtat', 'corpsEtatIds', 'corpsEtatId', 'corps_etat',
    'trade_ids', 'trade_id', 'trades',
  ]));

  filtres.statuts = liste(premiere(source, ['statuts', 'statuses', 'status']))
    .map((s) => s.toUpperCase())
    .filter((s) => R.CODES_STATUT_RAPPORT.includes(s));

  filtres.gravites = liste(premiere(source, ['gravites', 'gravite', 'severities', 'severity']))
    .map((s) => s.toUpperCase())
    .filter((s) => R.CODES_GRAVITE.includes(s));

  filtres.statutsReserve = liste(premiere(source, ['statutsReserve', 'statutReserve', 'statut']))
    .map((s) => s.toLowerCase());
  filtres.organisationsEntreprise = liste(premiere(source, ['organisationsEntreprise', 'entrepriseId']));
  filtres.phases = liste(premiere(source, ['phases', 'phaseIds', 'phaseId']));

  filtres.dateDebut = dateSeule(premiere(source, ['dateDebut', 'date_debut', 'date_from', 'dateFrom']));
  filtres.dateFin = dateSeule(premiere(source, ['dateFin', 'date_fin', 'date_to', 'dateTo']));

  // Une période à l'envers est une faute de saisie, pas un filtre : on la
  // remet à l'endroit plutôt que de renvoyer un rapport vide inexplicable.
  if (filtres.dateDebut && filtres.dateFin && filtres.dateDebut > filtres.dateFin) {
    const tampon = filtres.dateDebut;
    filtres.dateDebut = filtres.dateFin;
    filtres.dateFin = tampon;
  }

  return filtres;
}

/**
 * Applique les filtres imposés par un modèle (§ 5).
 *
 * Les filtres du modèle ne s'ajoutent que si l'utilisateur n'a rien choisi sur
 * cette dimension : « Rapport des réserves à traiter » pose un périmètre par
 * défaut, il ne l'impose pas — l'utilisateur peut vouloir ne voir que les
 * réserves en retard.
 */
function appliquerDefautsModele(filtres, modeleDef) {
  if (!modeleDef?.filtresParDefaut) return filtres;
  for (const [cle, valeur] of Object.entries(modeleDef.filtresParDefaut)) {
    const actuel = filtres[cle];
    if (Array.isArray(actuel) && actuel.length === 0) filtres[cle] = [...valeur];
    else if (!Array.isArray(actuel) && (actuel === null || actuel === undefined)) filtres[cle] = valeur;
  }
  return filtres;
}

/**
 * Structure du chantier — bâtiments, étages, zones — avec leurs noms.
 *
 * Sert deux fois : à traduire un libellé de niveau (« R+3 ») en identifiant,
 * et à écrire le périmètre en toutes lettres sur la couverture. Une seule
 * lecture pour les deux.
 */
async function chargerStructure(chantierId) {
  const batiments = await Batiment.findAll({
    where: { chantierId },
    attributes: ['id', 'nom', 'code'],
    include: [{
      model: Etage, as: 'etages', required: false,
      attributes: ['id', 'nom', 'niveau', 'codeNiveau', 'batimentId'],
      include: [{
        model: Zone, as: 'zones', required: false,
        attributes: ['id', 'nom', 'type', 'etageId'],
      }],
    }],
    order: [['nom', 'ASC']],
  });

  const parBatiment = new Map();
  const parEtage = new Map();
  const parZone = new Map();

  for (const batiment of batiments) {
    parBatiment.set(String(batiment.id), batiment);
    for (const etage of batiment.etages || []) {
      parEtage.set(String(etage.id), etage);
      for (const zone of etage.zones || []) parZone.set(String(zone.id), zone);
    }
  }

  return { batiments, parBatiment, parEtage, parZone };
}

/** Compare deux libellés sans se soucier de la casse ni des espaces. */
const memeLibelle = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Résout les filtres : libellés → identifiants, et noms pour l'affichage.
 *
 * Le § 10 donne l'exemple `"levels": ["R+3"]` — un LIBELLE, pas un
 * identifiant. L'application, elle, envoie des identifiants. Les deux sont
 * acceptés ; une valeur qu'on ne sait pas rattacher n'est pas ignorée en
 * silence, elle ressort dans `inconnus` pour que l'appelant puisse la
 * signaler plutôt que de livrer un rapport au périmètre faux.
 */
async function resoudreFiltres(chantierId, filtresBruts, { structure = null } = {}) {
  const filtres = normaliserFiltres(filtresBruts);
  const inconnus = { batiments: [], etages: [], zones: [] };

  const besoinStructure = filtres.batiments.length || filtres.etages.length || filtres.zones.length;
  const struct = structure || (besoinStructure ? await chargerStructure(chantierId) : null);

  const resoudre = (valeurs, index, correspond) => {
    if (!valeurs.length || !struct) return { ids: valeurs, noms: [] };
    const ids = [];
    const noms = [];
    for (const valeur of valeurs) {
      if (EST_UUID.test(valeur) && index.has(valeur)) {
        ids.push(valeur);
        noms.push(index.get(valeur));
        continue;
      }
      if (EST_UUID.test(valeur)) {
        // Identifiant bien formé mais étranger à ce chantier : refusé, jamais
        // silencieusement élargi (§ 21, « protection contre l'accès à un autre
        // chantier par modification d'identifiant »).
        inconnus[correspond.categorie].push(valeur);
        continue;
      }
      const trouve = correspond.parLibelle(valeur);
      if (trouve) {
        ids.push(String(trouve.id));
        noms.push(trouve);
      } else {
        inconnus[correspond.categorie].push(valeur);
      }
    }
    return { ids, noms };
  };

  const batiments = resoudre(filtres.batiments, struct?.parBatiment || new Map(), {
    categorie: 'batiments',
    parLibelle: (v) => (struct?.batiments || []).find((b) => memeLibelle(b.nom, v) || memeLibelle(b.code, v)),
  });
  const etages = resoudre(filtres.etages, struct?.parEtage || new Map(), {
    categorie: 'etages',
    parLibelle: (v) => [...(struct?.parEtage.values() || [])]
      .find((e) => memeLibelle(e.nom, v) || memeLibelle(e.codeNiveau, v)),
  });
  const zones = resoudre(filtres.zones, struct?.parZone || new Map(), {
    categorie: 'zones',
    parLibelle: (v) => [...(struct?.parZone.values() || [])].find((z) => memeLibelle(z.nom, v)),
  });

  filtres.batiments = batiments.ids;
  filtres.etages = etages.ids;
  filtres.zones = zones.ids;

  return { filtres, inconnus, structure: struct, noms: { batiments: batiments.noms, etages: etages.noms, zones: zones.noms } };
}

/**
 * Construit la clause SQL des réserves à partir des filtres canoniques.
 *
 * La période porte sur la DATE DE CRÉATION de la réserve : c'est la seule
 * date que toutes les réserves possèdent, et c'est celle qu'on entend par
 * « les réserves de septembre ».
 */
function construireWhere(chantierId, filtres) {
  const ou = { chantierId };

  if (filtres.batiments.length) ou.batimentId = { [Op.in]: filtres.batiments };
  if (filtres.etages.length) ou.etageId = { [Op.in]: filtres.etages };
  if (filtres.zones.length) ou.zoneId = { [Op.in]: filtres.zones };
  if (filtres.entreprises.length) ou.partenaireId = { [Op.in]: filtres.entreprises };
  if (filtres.corpsEtat.length) ou.corpsEtatId = { [Op.in]: filtres.corpsEtat };
  if (filtres.organisationsEntreprise?.length) ou.entrepriseId = { [Op.in]: filtres.organisationsEntreprise };
  if (filtres.phases?.length) ou.phaseId = { [Op.in]: filtres.phases };

  // Les statuts BRUTS de l'ancien point d'entrée priment : ils sont plus
  // précis que les cinq statuts du rapport, et l'appelant les a choisis.
  if (filtres.statutsReserve.length) {
    ou.statut = { [Op.in]: filtres.statutsReserve };
  } else if (filtres.statuts.length) {
    ou.statut = { [Op.in]: R.statutsReservePour(filtres.statuts) };
  }

  if (filtres.gravites.length) ou.severite = { [Op.in]: R.severitesPour(filtres.gravites) };

  if (filtres.dateDebut || filtres.dateFin) {
    ou.createdAt = {};
    if (filtres.dateDebut) ou.createdAt[Op.gte] = new Date(`${filtres.dateDebut}T00:00:00.000Z`);
    if (filtres.dateFin) ou.createdAt[Op.lte] = new Date(`${filtres.dateFin}T23:59:59.999Z`);
  }

  return ou;
}

/** Libellé d'un utilisateur : « Prénom Nom », ou son email à défaut. */
function nomUtilisateur(u) {
  if (!u) return null;
  const complet = [u.prenom, u.nom].filter(Boolean).join(' ').trim();
  return complet || u.email || null;
}

/** Chaîne de localisation, du plus large au plus fin. */
function localisationDe(reserve) {
  return [reserve.batiment?.nom, reserve.etage?.nom, reserve.zone?.nom].filter(Boolean).join(' › ');
}

/**
 * Lit l'historique d'une réserve pour en tirer les faits du § 17.
 *
 * Quatre choses, et aucune n'est devinée : la date à laquelle la correction a
 * été DÉCLARÉE, qui l'a déclarée (« la personne ayant demandé la levée »),
 * qui a validé (« la personne ayant contrôlé la correction »), et l'état
 * initial de la réserve tel qu'il a été enregistré à sa création.
 */
function analyserHistorique(lignes = []) {
  let dateCorrection = null;
  let demandeurLevee = null;
  let controleur = null;
  let dateValidation = null;
  let statutInitial = null;

  for (const ligne of lignes) {
    const nouveau = ligne.nouvelles_valeurs || {};
    if (ligne.action === 'creation' && !statutInitial) statutInitial = nouveau.statut || null;

    if (R.STATUTS_CORRECTION.includes(nouveau.statut)) {
      // La DERNIÈRE déclaration de correction fait foi : une réserve refusée
      // puis re-corrigée a deux dates, et c'est la seconde qui décrit l'état
      // que le rapport présente.
      dateCorrection = ligne.createdAt || dateCorrection;
      demandeurLevee = nomUtilisateur(ligne.utilisateur) || demandeurLevee;
    }

    if (ligne.action === 'validation' || nouveau.statut === 'validee') {
      controleur = nomUtilisateur(ligne.utilisateur) || controleur;
      dateValidation = ligne.createdAt || dateValidation;
    }
  }

  return { dateCorrection, demandeurLevee, controleur, dateValidation, statutInitial };
}

/** Une ligne d'historique lisible sur le document. */
function ligneHistoriqueLisible(ligne) {
  const ancien = ligne.anciennes_valeurs || {};
  const nouveau = ligne.nouvelles_valeurs || {};
  const libelleAction = R.LIBELLE_ACTION_RESERVE[ligne.action] || ligne.action;

  let detail = '';
  if (nouveau.statut && ancien.statut) {
    // « > » et non « → » : les polices standard du PDF (WinAnsi) n'ont pas de
    // flèche, et le caractère sortirait en symbole illisible.
    detail = `${R.LIBELLE_STATUT_RESERVE[ancien.statut] || ancien.statut} > ${R.LIBELLE_STATUT_RESERVE[nouveau.statut] || nouveau.statut}`;
  } else if (nouveau.statut) {
    detail = R.LIBELLE_STATUT_RESERVE[nouveau.statut] || nouveau.statut;
  } else if (ligne.action === 'commentaire' && nouveau.message) {
    detail = String(nouveau.message).slice(0, 160);
  } else if (ligne.action === 'modification') {
    detail = Object.keys(nouveau).slice(0, 6).join(', ');
  }

  return {
    date: ligne.createdAt,
    acteur: nomUtilisateur(ligne.utilisateur),
    action: libelleAction,
    detail,
  };
}

/**
 * Charge les données d'un rapport et les met en forme (§ 11, étapes 3 à 8).
 *
 * @param {object} options
 *  - chantier, organisation : le projet (déjà cloisonné par l'appelant) ;
 *  - filtres : filtres canoniques déjà résolus ;
 *  - modeleDef : le modèle du § 5 ;
 *  - sections : les sections du § 10 ;
 *  - auteur : l'utilisateur qui génère.
 */
async function chargerVue({
  chantier, organisation, filtres, modeleDef, sections, auteur, structure = null,
  rapport = null, dateRapport = new Date(),
}) {
  const where = construireWhere(chantier.id, filtres);

  const reserves = await Reserve.findAll({
    where,
    include: [
      { model: Batiment, as: 'batiment', attributes: ['id', 'nom', 'code'], required: false },
      { model: Etage, as: 'etage', attributes: ['id', 'nom', 'niveau', 'codeNiveau'], required: false },
      { model: Zone, as: 'zone', attributes: ['id', 'nom', 'type'], required: false },
      { model: Plan, as: 'plan', attributes: ['id', 'nom', 'fichier_url', 'format', 'page_count', 'version'], required: false },
      { model: Lot, as: 'lot', attributes: ['id', 'nom', 'code'], required: false },
      { model: Partenaire, as: 'partenaire', attributes: ['id', 'nom', 'email', 'contact'], required: false },
      { model: Organisation, as: 'entreprise', attributes: ['id', 'nom'], required: false },
      { model: CorpsEtat, as: 'corpsEtat', attributes: ['id', 'nom', 'code'], required: false },
      { model: Phase, as: 'phase', attributes: ['id', 'nom', 'ordre'], required: false },
      { model: Media, as: 'medias', attributes: ['id', 'type', 'url', 'thumbnail_url', 'pris_le', 'createdAt'], required: false },
      { model: ReservePosition, as: 'position', attributes: ['id', 'x', 'y', 'page'], required: false },
      { model: Utilisateur, as: 'validateur', attributes: ['id', 'nom', 'prenom', 'email'], required: false },
      { model: Utilisateur, as: 'createur', attributes: ['id', 'nom', 'prenom', 'email'], required: false },
    ],
    order: [['numero', 'ASC'], ['createdAt', 'ASC']],
  });

  // ── Historique (§ 6 « Historique, si activé » et § 17) ──────────────────
  //
  // Lu SÉPARÉMENT plutôt qu'en jointure : une réserve suivie depuis six mois
  // porte des dizaines de lignes, et les multiplier par les jointures
  // précédentes ferait exploser le nombre de lignes remontées.
  const besoinHistorique = Boolean(sections?.history) || modeleDef?.fiche === 'levee';
  const historiquesParReserve = new Map();
  if (besoinHistorique && reserves.length) {
    const lignes = await ReserveHistorique.findAll({
      where: { reserveId: { [Op.in]: reserves.map((r) => r.id) } },
      include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'email'], required: false }],
      order: [['createdAt', 'ASC']],
      limit: 5000,
    });
    for (const ligne of lignes) {
      const cle = String(ligne.reserveId);
      if (!historiquesParReserve.has(cle)) historiquesParReserve.set(cle, []);
      historiquesParReserve.get(cle).push(ligne);
    }
  }

  // Les faits du § 17 doivent être connus AVANT de charger les photos : c'est
  // la date de correction qui sépare l'avant de l'après.
  const analyses = new Map();
  for (const reserve of reserves) {
    const analyse = analyserHistorique(historiquesParReserve.get(String(reserve.id)) || []);
    analyses.set(String(reserve.id), analyse);
    reserve.dateCorrection = analyse.dateCorrection;
  }

  // ── Photos et plans ────────────────────────────────────────────────────
  let photos = { chargees: 0, ignorees: 0 };
  if (sections?.photos !== false) {
    try {
      photos = await medias.chargerPhotos(reserves, { fiche: modeleDef?.fiche || 'standard' });
    } catch {
      // Un stockage injoignable coûte les images, jamais le rapport.
      for (const reserve of reserves) {
        reserve.photos = reserve.photos || [];
        reserve.photosAvant = reserve.photosAvant || [];
        reserve.photosApres = reserve.photosApres || [];
      }
    }
  } else {
    for (const reserve of reserves) {
      reserve.photos = [];
      reserve.photosAvant = [];
      reserve.photosApres = [];
    }
  }

  let plans = new Map();
  if (sections?.plans !== false) {
    try {
      plans = await medias.chargerPlans(reserves);
    } catch {
      plans = new Map();
    }
  }

  // ── Fiches ─────────────────────────────────────────────────────────────
  const fiches = reserves.map((reserve) => {
    const analyse = analyses.get(String(reserve.id)) || {};
    const statutRapport = R.statutRapportDe(reserve.statut);
    const gravite = R.graviteDe(reserve.severite);
    const position = reserve.position;

    return {
      id: reserve.id,
      numero: reserve.numero,
      titre: reserve.titre,
      description: reserve.description,

      statutReserve: reserve.statut,
      statutDetail: R.LIBELLE_STATUT_RESERVE[reserve.statut] || reserve.statut,
      statutRapport,
      statutRapportLibelle: statutRapport ? R.libelleStatutRapport(statutRapport) : null,

      severite: reserve.severite,
      gravite,
      graviteLibelle: gravite ? R.libelleGravite(gravite) : null,

      batiment: reserve.batiment?.nom || null,
      etage: reserve.etage?.nom || null,
      zone: reserve.zone?.nom || null,
      localisation: localisationDe(reserve),

      // L'entreprise affichée suit la priorité de l'application : le
      // partenaire (l'entreprise réelle du chantier) prime sur l'organisation.
      entrepriseId: reserve.partenaireId || null,
      entreprise: reserve.partenaire?.nom || reserve.entreprise?.nom || null,
      corpsEtat: reserve.corpsEtat?.nom || null,
      lot: reserve.lot ? [reserve.lot.code, reserve.lot.nom].filter(Boolean).join(' - ') : null,
      phase: reserve.phase?.nom || null,

      dateCreation: reserve.createdAt,
      dateLimite: reserve.date_limite,
      dateValidation: reserve.date_validation || analyse.dateValidation || null,
      dateCorrection: analyse.dateCorrection || null,

      photos: reserve.photos || [],
      photosAvant: reserve.photosAvant || [],
      photosApres: reserve.photosApres || [],

      // § 7 — la position est stockée en POURCENTAGES (0-100) ; le cahier des
      // charges raisonne en coordonnées normalisées (0-1). La conversion se
      // fait ici, une fois, et les deux générateurs lisent la même valeur.
      plan: reserve.plan ? {
        id: reserve.plan.id,
        nom: reserve.plan.nom,
        version: reserve.plan.version,
        format: reserve.plan.format,
        page: position?.page || 1,
        x: position ? position.x / 100 : null,
        y: position ? position.y / 100 : null,
        pourcentX: position ? position.x : null,
        pourcentY: position ? position.y : null,
      } : null,

      historique: (historiquesParReserve.get(String(reserve.id)) || []).map(ligneHistoriqueLisible),

      // § 17 — le rapport de levée.
      levee: {
        statutInitial: analyse.statutInitial
          ? (R.LIBELLE_STATUT_RESERVE[analyse.statutInitial] || analyse.statutInitial)
          : null,
        dateCorrection: analyse.dateCorrection || null,
        entreprise: reserve.partenaire?.nom || reserve.entreprise?.nom || null,
        demandeur: analyse.demandeurLevee || null,
        controleur: analyse.controleur || nomUtilisateur(reserve.validateur),
        dateValidation: reserve.date_validation || analyse.dateValidation || null,
        statutFinal: R.LIBELLE_STATUT_RESERVE[reserve.statut] || reserve.statut,
      },

      createur: nomUtilisateur(reserve.createur),
    };
  });

  return {
    reserves: fiches,
    groupes: grouperFiches(fiches, modeleDef?.groupement || 'localisation'),
    synthese: construireSynthese(fiches),
    plans,
    nbPhotos: photos.chargees,
    nbPhotosIgnorees: photos.ignorees,
    chantier,
    organisation,
    auteur,
    filtres,
    modeleDef,
    sections,
    rapport,
    dateRapport,
    structure,
  };
}

/**
 * Groupe les fiches selon l'axe de lecture du modèle.
 *
 * Un rapport se lit dans l'ordre où l'on parcourt le chantier : plan par plan
 * pour un OPR, entreprise par entreprise pour une relance. Le groupement
 * n'est donc pas une décoration — c'est ce qui rend le document utilisable
 * sur place.
 */
function grouperFiches(fiches, axe) {
  const groupes = new Map();

  const cleEtLibelle = (fiche) => {
    switch (axe) {
      case 'entreprise':
        return fiche.entreprise
          ? { cle: `e:${fiche.entrepriseId || fiche.entreprise}`, libelle: fiche.entreprise }
          : { cle: 'e:sans', libelle: 'Sans entreprise identifiée' };
      case 'corps_etat':
        return fiche.corpsEtat
          ? { cle: `c:${fiche.corpsEtat}`, libelle: fiche.corpsEtat }
          : { cle: 'c:sans', libelle: 'Sans corps d’état' };
      case 'etage': {
        const libelle = [fiche.batiment, fiche.etage].filter(Boolean).join(' › ');
        return libelle ? { cle: `n:${libelle}`, libelle } : { cle: 'n:sans', libelle: 'Sans niveau' };
      }
      case 'echeance': {
        // Trois paquets qui parlent d'eux-mêmes sur un chantier : ce qui est
        // en retard, ce qui a une date, ce qui n'en a pas.
        if (fiche.statutReserve === 'en_retard') return { cle: 'r:retard', libelle: 'En retard' };
        if (fiche.dateLimite) return { cle: 'r:date', libelle: 'Avec échéance' };
        return { cle: 'r:sans', libelle: 'Sans échéance' };
      }
      case 'localisation':
      default:
        return fiche.localisation
          ? { cle: `l:${fiche.localisation}`, libelle: fiche.localisation }
          : { cle: 'l:sans', libelle: 'Sans localisation' };
    }
  };

  for (const fiche of fiches) {
    const { cle, libelle } = cleEtLibelle(fiche);
    if (!groupes.has(cle)) groupes.set(cle, { cle, libelle, reserves: [] });
    groupes.get(cle).reserves.push(fiche);
  }

  const sortie = [...groupes.values()];

  if (axe === 'echeance') {
    // Le retard d'abord, l'absence d'échéance en dernier : mettre en tête une
    // réserve sans date laisserait croire à une urgence que rien n'atteste.
    const ordre = { 'r:retard': 0, 'r:date': 1, 'r:sans': 2 };
    sortie.sort((a, b) => (ordre[a.cle] ?? 3) - (ordre[b.cle] ?? 3));
    for (const groupe of sortie) {
      groupe.reserves.sort((a, b) => {
        if (!a.dateLimite && !b.dateLimite) return 0;
        if (!a.dateLimite) return 1;
        if (!b.dateLimite) return -1;
        return String(a.dateLimite).localeCompare(String(b.dateLimite));
      });
    }
  }

  return sortie;
}

/**
 * La synthèse du § 6 (page 2) : les totaux par statut, par gravité et par
 * entreprise.
 *
 * Tout est compté sur les fiches réellement retenues. La somme des colonnes
 * est donc toujours égale au total — c'est la première chose que vérifie
 * quelqu'un qui reçoit le document.
 */
function construireSynthese(fiches) {
  const parStatut = {};
  for (const code of R.CODES_STATUT_RAPPORT) parStatut[code] = 0;
  let statutInconnu = 0;

  const parGravite = {};
  for (const code of R.CODES_GRAVITE) parGravite[code] = 0;
  let graviteNonRenseignee = 0;

  const entreprises = new Map();

  for (const fiche of fiches) {
    if (fiche.statutRapport) parStatut[fiche.statutRapport] += 1;
    else statutInconnu += 1;

    if (fiche.gravite) parGravite[fiche.gravite] += 1;
    else graviteNonRenseignee += 1;

    const cle = fiche.entreprise || '—sans—';
    if (!entreprises.has(cle)) {
      entreprises.set(cle, {
        entreprise: fiche.entreprise || 'Sans entreprise identifiée',
        total: 0,
        ...Object.fromEntries(R.CODES_STATUT_RAPPORT.map((c) => [c, 0])),
      });
    }
    const ligne = entreprises.get(cle);
    ligne.total += 1;
    if (fiche.statutRapport) ligne[fiche.statutRapport] += 1;
  }

  return {
    total: fiches.length,
    parStatut,
    statutInconnu,
    parGravite,
    graviteNonRenseignee,
    // La plus chargée d'abord : c'est l'entreprise à relancer en premier.
    parEntreprise: [...entreprises.values()].sort((a, b) => b.total - a.total),
  };
}

module.exports = {
  normaliserFiltres,
  appliquerDefautsModele,
  resoudreFiltres,
  chargerStructure,
  construireWhere,
  chargerVue,
  grouperFiches,
  construireSynthese,
  analyserHistorique,
  filtresVides,
  EST_UUID,
};
