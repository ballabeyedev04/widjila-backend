'use strict';

const { Op } = require('sequelize');
const {
  Chantier, Batiment, Etage, Zone, Lot, Reserve, Utilisateur, ChantierMembre,
  Phase, Inspection, Plan, Annotation, Document, Rapport, Checklist,
  Commentaire, PieceJointe, Organisation, PlanHotspot,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const NotificationService = require('../../notification/service/notification.service.js');
const escapeLike = require('../../../utils/escapeLike.js');
const { GESTION } = require('../../../config/roles.js');
const { STATUT_CHANTIER_EN_DEMANDE } = require('../../../config/enums.js');
const { sendChantierValidationEmail } = require('../../../infrastructure/emailService.js');
const logger = require('../../../utils/logger.js');

/**
 * Efface les zones cliquables qui pointaient vers une structure supprimée.
 *
 * `cible_type` + `cible_id` forment une association polymorphe : PostgreSQL ne
 * sait pas la contraindre, donc rien ne nettoie ces lignes automatiquement.
 * Un hotspot orphelin ne « casse » pas l'affichage — les clients tolèrent une
 * cible disparue — mais il laisse sur le plan une pastille qui ne mène nulle
 * part, ce qui est pire qu'une absence de repère.
 */
async function _supprimerHotspotsDeLaStructure({ batimentIds, etageIds, zoneIds }, transaction) {
  const conditions = [
    { type: 'batiment', ids: batimentIds },
    { type: 'etage', ids: etageIds },
    { type: 'zone', ids: zoneIds },
  ].filter((c) => c.ids && c.ids.length);

  if (!conditions.length) return;

  await PlanHotspot.destroy({
    where: {
      [Op.or]: conditions.map((c) => ({ cible_type: c.type, cible_id: { [Op.in]: c.ids } })),
    },
    transaction,
  });
}

// Statuts « fin de vie » d'un chantier : aucun ne doit pouvoir être atteint
// tant qu'il reste des réserves ouvertes (cf. changerStatut).
const STATUTS_FERMETURE = ['cloture', 'archive'];

// Statuts de réserve considérés comme soldés.
const RESERVE_SOLDEE = ['validee', 'cloturee'];

/**
 * Restreint la visibilité aux chantiers qu'un compte a le droit de voir.
 *
 * Le client demande qu'un chantier validé ne soit utilisable que par
 * l'entreprise qui l'a demandé. La règle ne vise QUE les chantiers issus du
 * circuit (`demandeurId` renseigné) : les autres — c'est-à-dire tous ceux qui
 * existent aujourd'hui — gardent leur visibilité d'organisation. Élargir le
 * cloisonnement à l'existant ferait disparaître des chantiers de l'écran de
 * leurs équipes sans que personne ne l'ait demandé.
 *
 * Voient malgré tout une demande qui n'est pas la leur : les rôles de GESTION
 * (ils la tranchent, puis supervisent le chantier validé) et le super-admin
 * plateforme, déjà hors organisation.
 *
 * @returns {object|null} Fragment de `where`, ou `null` si aucun filtre.
 */
function _filtreCloisonnement(auteur) {
  if (!auteur || !auteur.id) return null;
  if (auteur.role === 'Admin' || GESTION.includes(auteur.role)) return null;

  return {
    [Op.or]: [
      // Chantiers hors circuit : visibilité d'organisation, inchangée.
      { demandeurId: null },
      // Chantiers issus du circuit : les siens seulement.
      { demandeurId: auteur.id },
      // Chantiers auxquels le compte est explicitement affecté. L'affectation
      // existe déjà (`ChantierMembre`) : la prendre en compte ici évitera de
      // retoucher cette règle quand l'interface l'exposera.
      {
        id: {
          [Op.in]: sequelize.literal(
            `(SELECT chantier_id FROM chantier_membres WHERE utilisateur_id = ${sequelize.escape(auteur.id)})`
          ),
        },
      },
    ],
  };
}

/**
 * Destinataires d'une demande de chantier : les comptes actifs de
 * l'organisation habilités à trancher.
 *
 * TOUS, et non le premier trouvé : un seul destinataire en congé suffirait à
 * bloquer une demande indéfiniment. Le super-admin plateforme n'est pas
 * concerné — il n'appartient à aucune organisation.
 */
async function _valideursDe(organisationId) {
  const membres = await Utilisateur.findAll({
    where: {
      organisationId,
      role: { [Op.in]: GESTION.filter((r) => r !== 'Admin') },
      statut: 'actif',
    },
    attributes: ['email', 'prenom', 'nom'],
  });
  return membres.filter((m) => m.email);
}

/**
 * Envoie un courriel du circuit SANS jamais faire échouer l'action métier.
 *
 * Une demande enregistrée puis perdue parce que le fournisseur d'envoi était
 * indisponible serait le pire des deux mondes : l'utilisateur verrait une
 * erreur alors que sa demande existe. L'échec est journalisé, pas propagé.
 */
async function _notifier(charge) {
  try {
    await sendChantierValidationEmail(charge);
  } catch (e) {
    logger.error(
      `Courriel de validation de chantier non envoyé (${charge.variante}) : ${e.message}`
    );
  }
}

class ChantierService {
  /**
   * Règle de visibilité des chantiers, exposée pour que d'AUTRES vues du même
   * portefeuille l'appliquent à l'identique.
   *
   * Elle ne vivait que dans `listChantiers`. Le tableau de bord, lui,
   * comptait à l'échelle de l'organisation : une entreprise voyait
   * « 1 chantier » sur son écran d'accueil et une liste vide juste à côté,
   * pour un chantier qu'elle n'avait pas le droit d'ouvrir. Un compteur qui
   * annonce ce qu'on ne peut pas atteindre passe pour une panne de
   * chargement — c'est exactement ainsi qu'il a été signalé.
   *
   * @param {object|null} auteur `req.user`
   * @returns {object|null} Fragment de `where`, ou `null` si l'auteur voit tout.
   */
  static filtreCloisonnement(auteur) {
    return _filtreCloisonnement(auteur);
  }


  // -------------------- CRÉER UN CHANTIER --------------------
  /**
   * @param {string} organisationId
   * @param {object} data
   * @param {object} [auteur]  Compte appelant — `{ id, role, prenom, nom }`.
   *   Détermine si le chantier naît ACTIF ou EN ATTENTE : seul le super-admin
   *   plateforme crée un chantier directement utilisable, tout autre compte
   *   dépose une demande. L'auteur est passé par le contrôleur d'après le
   *   jeton, JAMAIS d'après le corps de la requête — sinon n'importe qui
   *   contournerait la validation en s'annonçant « Admin ».
   */
  static async creerChantier(organisationId, data, auteur = null) {
    const enAttente = ChantierService._naitEnAttente(auteur);
    // L'organisation vient soit du compte appelant, soit — pour le super-admin
    // plateforme, qui n'appartient à aucune organisation — du corps de la
    // requête (voir chantier.controller.js#creerChantier). On la valide ici :
    // sans ce contrôle, un identifiant inexistant remontait sous forme
    // d'erreur de clé étrangère PostgreSQL, illisible côté interface.
    const organisation = await Organisation.findByPk(organisationId, { attributes: ['id'] });
    if (!organisation) {
      return { success: false, message: 'Organisation introuvable' };
    }

    // Vérifier que le responsable appartient bien à l'organisation
    if (data.responsableId) {
      const responsable = await Utilisateur.findOne({
        where: { id: data.responsableId, organisationId },
      });
      if (!responsable) {
        return { success: false, message: 'Le responsable n’appartient pas à cette organisation' };
      }
    }

    // Code auto si absent : CH-XXXX (4 caractères hex)
    const code = data.code || `CH-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

    const chantier = await Chantier.create({
      organisationId,
      code,
      nom: data.nom,
      description: data.description || null,
      adresse: data.adresse || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      date_debut: data.date_debut || null,
      date_fin: data.date_fin || null,
      responsableId: data.responsableId || null,
      budget: data.budget || null,
      // Le statut n'est PAS repris du corps de la requête quand une validation
      // est due : un `statut: 'en_cours'` envoyé par une entreprise aurait
      // sinon suffi à sauter le circuit.
      statut: enAttente ? 'en_attente_validation' : (data.statut || 'en_preparation'),
      demandeurId: enAttente ? auteur.id : null,
    });

    if (!enAttente) {
      return { success: true, message: 'Chantier créé avec succès', chantier };
    }

    // Les valideurs sont prévenus APRÈS l'enregistrement : une demande qui
    // existe sans courriel se rattrape à l'écran ; un courriel annonçant une
    // demande qui n'existe pas ne se rattrape pas.
    const valideurs = await _valideursDe(organisationId);
    await Promise.all(valideurs.map((v) => _notifier({
      to: v.email,
      variante: 'demande',
      destinataire: v.prenom || v.nom || '',
      chantierNom: chantier.nom,
      chantierCode: chantier.code,
      demandeurNom: [auteur.prenom, auteur.nom].filter(Boolean).join(' ') || '',
      chantierId: chantier.id,
    })));

    return {
      success: true,
      message: 'Demande de création de chantier envoyée — elle attend une validation',
      chantier,
    };
  }

  /**
   * Le chantier naît-il en attente de validation ?
   *
   * « N'importe qui qui crée le chantier sauf Admin reste en attente » : seul
   * le super-admin plateforme échappe au circuit. Un appel sans auteur
   * identifié (amorçage, tests, duplication interne) crée directement — il n'y
   * aurait personne à qui attribuer la demande, ni personne pour la trancher.
   */
  static _naitEnAttente(auteur) {
    return Boolean(auteur && auteur.id && auteur.role !== 'Admin');
  }

  // -------------------- VALIDER / REJETER UNE DEMANDE --------------------
  /**
   * Accepte une demande : le chantier devient réellement utilisable.
   *
   * Le motif de refus éventuel est EFFACÉ — la demande a été corrigée puis
   * acceptée, laisser l'ancien motif ferait croire à un refus toujours actif.
   */
  static async validerChantier(chantierId, valideur) {
    const chantier = await Chantier.findByPk(chantierId, {
      include: [{ model: Utilisateur, as: 'demandeur', attributes: ['email', 'prenom', 'nom'] }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    if (!STATUT_CHANTIER_EN_DEMANDE.includes(chantier.statut)) {
      return { success: false, message: 'Ce chantier n’est pas en attente de validation' };
    }

    await chantier.update({
      statut: 'en_preparation',
      motifRejet: null,
      valideParId: valideur.id,
      valideLe: new Date(),
    });

    // Les plans joints suivent le chantier : validés avec lui, ils deviennent
    // exploitables au même instant. Sans cette cascade, le chantier serait
    // ouvert mais ses plans resteraient invisibles — l'entreprise recevrait un
    // courriel de validation pour un chantier vide.
    //
    // Ciblé sur les plans EN ATTENTE : un plan déjà actif (dépôt ultérieur sur
    // un chantier revalidé) n'a pas à être retouché.
    await Plan.update(
      { statut: 'actif' },
      { where: { chantierId: chantier.id, statut: 'en_attente_validation' } }
    );

    if (chantier.demandeur && chantier.demandeur.email) {
      await _notifier({
        to: chantier.demandeur.email,
        variante: 'validee',
        destinataire: chantier.demandeur.prenom || chantier.demandeur.nom || '',
        chantierNom: chantier.nom,
        chantierCode: chantier.code,
        chantierId: chantier.id,
      });
    }

    return { success: true, message: 'Chantier validé', chantier };
  }

  /**
   * Refuse une demande, avec un motif.
   *
   * Le motif est OBLIGATOIRE (garanti en amont par la validation de schéma) :
   * c'est la seule indication dont dispose le demandeur pour corriger, et le
   * client a demandé qu'il puisse « corriger et renvoyer ».
   *
   * Le chantier n'est PAS supprimé : sa structure et ses plans doivent
   * survivre à la correction, sans quoi tout serait à ressaisir.
   */
  static async rejeterChantier(chantierId, valideur, motif) {
    const chantier = await Chantier.findByPk(chantierId, {
      include: [{ model: Utilisateur, as: 'demandeur', attributes: ['email', 'prenom', 'nom'] }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    if (chantier.statut !== 'en_attente_validation') {
      return { success: false, message: 'Ce chantier n’est pas en attente de validation' };
    }

    await chantier.update({
      statut: 'rejete',
      motifRejet: motif,
      valideParId: valideur.id,
      valideLe: new Date(),
    });

    if (chantier.demandeur && chantier.demandeur.email) {
      await _notifier({
        to: chantier.demandeur.email,
        variante: 'rejetee',
        destinataire: chantier.demandeur.prenom || chantier.demandeur.nom || '',
        chantierNom: chantier.nom,
        chantierCode: chantier.code,
        motif,
        chantierId: chantier.id,
      });
    }

    return { success: true, message: 'Demande refusée', chantier };
  }

  // -------------------- LISTER LES CHANTIERS --------------------
  /**
   * @param {string|null} organisationId  Organisation à lister.
   * @param {object} query                Pagination / recherche / statut.
   * @param {object} [options]
   * @param {boolean} [options.toutesOrganisations]  Ignore le filtre par
   *   organisation. RÉSERVÉ au super-admin plateforme (`role: 'Admin'`), qui
   *   n'appartient à aucune organisation : sans cela, il crée des chantiers
   *   pour ses clients puis ne les voit jamais dans la liste, celle-ci
   *   filtrant sur son propre `organisationId` — c'est-à-dire `null`.
   *   Le drapeau est posé par le contrôleur d'après le rôle, JAMAIS d'après
   *   un paramètre de requête : il ouvre la lecture à toutes les organisations.
   */
  static async listChantiers(
    organisationId,
    { page = 1, limit = 20, search = '', statut, demandes } = {},
    { toutesOrganisations = false, utilisateurId = null, auteur = null } = {}
  ) {
    const where = {};
    if (!toutesOrganisations) where.organisationId = organisationId;
    else if (organisationId) where.organisationId = organisationId; // filtre facultatif du super-admin
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { code: { [Op.iLike]: motif } },
      ];
    }
    // ── Chantiers en activité / demandes ──────────────────────────────────
    //
    // Par défaut la liste ÉCARTE les demandes : un chantier en attente ou
    // refusé n'est pas un chantier, et le laisser apparaître ferait travailler
    // des équipes sur un projet qui n'existe pas encore.
    //
    // Les deux vues du client ouvrent explicitement cette réserve :
    //   - `demandes=mes`       → « Suivi des demandes » du demandeur ;
    //   - `demandes=a_valider` → la file d'attente de ceux qui tranchent.
    if (statut) {
      where.statut = statut;
    } else if (demandes === 'mes') {
      where.statut = { [Op.in]: STATUT_CHANTIER_EN_DEMANDE };
      // Ses PROPRES demandes : sans ce filtre, un demandeur verrait celles de
      // toute l'organisation, y compris leurs motifs de refus.
      if (utilisateurId) where.demandeurId = utilisateurId;
    } else if (demandes === 'a_valider') {
      where.statut = 'en_attente_validation';
    } else {
      where.statut = { [Op.notIn]: STATUT_CHANTIER_EN_DEMANDE };
    }

    // Cloisonnement — appliqué APRÈS les autres filtres, en `Op.and`, pour ne
    // pas écraser un `Op.or` déjà posé par la recherche.
    const cloisonnement = _filtreCloisonnement(auteur);
    if (cloisonnement) where[Op.and] = [...(where[Op.and] || []), cloisonnement];

    const { rows, count } = await Chantier.findAndCountAll({
      where,
      include: [
        { model: Utilisateur, as: 'responsable', attributes: ['id', 'nom', 'prenom', 'email', 'photoProfil'] },
        // L'organisation propriétaire : sans elle, la liste « toutes
        // organisations » du super-admin affiche des chantiers homonymes sans
        // moyen de savoir à quel client ils appartiennent.
        { model: Organisation, as: 'organisation', attributes: ['id', 'nom'] },
        // L'auteur de la demande : la file d'attente doit dire QUI demande,
        // un nom de chantier seul ne permet pas de trancher.
        { model: Utilisateur, as: 'demandeur', attributes: ['id', 'nom', 'prenom', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    // Compteurs de réserves par chantier (batch — une requête, pas N+1)
    const chantierIds = rows.map((c) => c.id);
    const compteurs = chantierIds.length
      ? await Reserve.findAll({
          where: { chantierId: chantierIds },
          attributes: ['chantierId', 'statut'],
          raw: true,
        })
      : [];

    const statsMap = {};
    for (const c of compteurs) {
      statsMap[c.chantierId] = statsMap[c.chantierId] || { total: 0, ouvertes: 0, validees: 0 };
      statsMap[c.chantierId].total += 1;
      if (['validee', 'cloturee'].includes(c.statut)) statsMap[c.chantierId].validees += 1;
      else statsMap[c.chantierId].ouvertes += 1;
    }

    const chantiers = rows.map((c) => {
      const cj = c.toJSON();
      cj.statsReserves = statsMap[c.id] || { total: 0, ouvertes: 0, validees: 0 };
      return cj;
    });

    return { success: true, chantiers, total: count };
  }

  // -------------------- DÉTAIL D'UN CHANTIER --------------------
  /**
   * @param {object} [auteur]  Compte appelant. Applique le cloisonnement des
   *   chantiers issus du circuit — sans lui, le filtre de la liste se
   *   contournerait en ouvrant l'URL du chantier directement.
   */
  static async getChantier(chantierId, auteur = null) {
    const chantier = await Chantier.findByPk(chantierId, {
      include: [
        { model: Utilisateur, as: 'responsable', attributes: ['id', 'nom', 'prenom', 'email', 'photoProfil'] },
        // L'organisation propriétaire : le super-admin plateforme ouvre les
        // chantiers de TOUS les clients, il doit savoir lequel il consulte.
        { model: Organisation, as: 'organisation', attributes: ['id', 'nom'] },
        {
          model: Batiment,
          as: 'batiments',
          include: [{
            model: Etage,
            as: 'etages',
            include: [{ model: Zone, as: 'zones' }],
          }],
        },
        { model: Lot, as: 'lots' },
      ],
      order: [[{ model: Batiment, as: 'batiments' }, 'nom', 'ASC']],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // Cloisonnement : un chantier issu du circuit n'appartient qu'à son
    // demandeur (et à ceux qui le valident). « Introuvable » plutôt que
    // « interdit » — répondre 403 confirmerait l'existence du chantier d'un
    // concurrent à qui n'a pas à le savoir.
    if (!ChantierService._peutVoir(chantier, auteur)) {
      return { success: false, message: 'Chantier introuvable' };
    }

    return { success: true, chantier };
  }

  /**
   * Ce compte peut-il voir ce chantier ?
   *
   * Miroir de `_filtreCloisonnement`, appliqué à un objet déjà chargé. Les
   * deux doivent dire la même chose : la liste et le détail qui divergeraient
   * donneraient un chantier introuvable dans la liste mais ouvrable par son
   * URL — ou l'inverse.
   *
   * L'affectation explicite n'est PAS relue ici : elle demanderait une requête
   * de plus sur chaque lecture, et l'interface ne l'expose pas encore. Un
   * membre affecté à un chantier issu du circuit le verra dans sa liste et
   * recevra « introuvable » en l'ouvrant — à corriger le jour où l'affectation
   * sera exposée.
   */
  static _peutVoir(chantier, auteur) {
    if (!auteur || !auteur.id) return true;
    if (auteur.role === 'Admin' || GESTION.includes(auteur.role)) return true;
    if (!chantier.demandeurId) return true;
    return String(chantier.demandeurId) === String(auteur.id);
  }

  // -------------------- MODIFIER UN CHANTIER --------------------
  /**
   * @param {object} [auteur]  Compte appelant. Sert au RENVOI d'une demande
   *   refusée : corriger un chantier « rejete » le repropose à la validation.
   */
  static async modifierChantier(organisationId, chantierId, data, auteur = null) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    if (data.responsableId && data.responsableId !== chantier.responsableId) {
      const responsable = await Utilisateur.findOne({
        where: { id: data.responsableId, organisationId },
      });
      if (!responsable) return { success: false, message: 'Le responsable n’appartient pas à cette organisation' };
    }

    const updates = {};
    for (const champ of ['code', 'nom', 'description', 'adresse', 'latitude', 'longitude', 'date_debut', 'date_fin', 'responsableId', 'budget']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }

    // ── Renvoi après refus ────────────────────────────────────────────────
    //
    // Le client a demandé que le demandeur « puisse corriger et renvoyer ».
    // Corriger un chantier refusé le remet donc dans la file d'attente, sans
    // écran ni bouton supplémentaire : la correction EST le renvoi.
    //
    // Le motif est effacé — il porte sur la version corrigée, qui n'existe
    // plus. Le laisser afficherait un reproche déjà traité.
    const renvoi = chantier.statut === 'rejete' && ChantierService._naitEnAttente(auteur);
    if (renvoi) {
      updates.statut = 'en_attente_validation';
      updates.motifRejet = null;
      updates.valideParId = null;
      updates.valideLe = null;
    }

    await chantier.update(updates);

    if (renvoi) {
      const valideurs = await _valideursDe(organisationId);
      await Promise.all(valideurs.map((v) => _notifier({
        to: v.email,
        variante: 'demande',
        destinataire: v.prenom || v.nom || '',
        chantierNom: chantier.nom,
        chantierCode: chantier.code,
        demandeurNom: [auteur.prenom, auteur.nom].filter(Boolean).join(' ') || '',
        chantierId: chantier.id,
      })));
      return { success: true, message: 'Demande corrigée et renvoyée pour validation', chantier };
    }

    return { success: true, message: 'Chantier mis à jour avec succès', chantier };
  }

  // -------------------- CHANGER LE STATUT --------------------
  static async changerStatut(organisationId, chantierId, statut) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // ── Le circuit de validation n'est pas une liste déroulante ────────────
    //
    // Les deux statuts de demande sont servis par `/referentiels/enums` : sans
    // cette garde, ils apparaîtraient dans « changer le statut » et un chef de
    // projet remettrait un chantier en activité « en attente » d'un clic —
    // sans demandeur, sans motif, sans courriel, et hors de toutes les listes.
    if (STATUT_CHANTIER_EN_DEMANDE.includes(statut)) {
      return {
        success: false,
        message: 'Ce statut appartient au circuit de validation : il ne se choisit pas ici.',
      };
    }

    // Et le sens inverse : une demande ne devient pas un chantier actif par la
    // liste déroulante. Elle se VALIDE — c'est ce qui prévient le demandeur.
    if (STATUT_CHANTIER_EN_DEMANDE.includes(chantier.statut)) {
      return {
        success: false,
        message: 'Ce chantier est une demande en cours : validez-la ou refusez-la.',
      };
    }

    // Règle métier : un chantier ne peut pas être clôturé s'il reste des
    // réserves ouvertes (statut différent de validee/cloturee).
    //
    // CORRECTIF (audit § 9) — la garde ne visait que 'cloture'. Or 'archive'
    // ferme tout autant le chantier (il sort des tableaux de bord actifs) :
    // il suffisait donc d'archiver au lieu de clôturer pour solder un chantier
    // avec des réserves non levées, exactement ce que la règle interdit.
    if (STATUTS_FERMETURE.includes(statut)) {
      const ouvertes = await Reserve.count({
        where: {
          chantierId,
          statut: { [Op.notIn]: RESERVE_SOLDEE },
        },
      });
      if (ouvertes > 0) {
        const action = statut === 'archive' ? 'd’archiver' : 'de clôturer';
        return {
          success: false,
          message: `Impossible ${action} le chantier : ${ouvertes} réserve(s) encore ouverte(s).`,
        };
      }
    }

    await chantier.update({ statut });
    return { success: true, message: 'Statut du chantier mis à jour', chantier };
  }

  // -------------------- SUPPRIMER UN CHANTIER --------------------
  /**
   * CORRECTIF (audit § 4) — le soft delete NE CASCADE PAS.
   *
   * L'ancien commentaire « cascade par association » était faux : les
   * `onDelete: CASCADE` déclarés dans models/index.js sont des contraintes
   * référentielles SQL, déclenchées uniquement par un DELETE physique. Un soft
   * delete n'est qu'un `UPDATE chantiers SET deleted_at = now()` : réserves,
   * plans, documents, bâtiments et inspections restaient `deleted_at IS NULL`,
   * donc invisibles via l'API (leur chantier ayant disparu) mais toujours
   * comptés par les agrégats globaux — `statistiques.service.js` fait un
   * `Reserve.count()` sans jointure, qui gonflait indéfiniment.
   *
   * On soft delete donc explicitement toute la descendance paranoid, dans une
   * transaction (tout ou rien : un chantier à moitié supprimé serait pire que
   * pas supprimé du tout).
   */
  static async supprimerChantier(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const t = await sequelize.transaction();
    try {
      await ChantierService._supprimerDescendance(chantierId, t);
      await chantier.destroy({ transaction: t }); // soft delete du chantier
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Chantier supprimé' };
  }

  /**
   * Soft delete de toute la descendance paranoid d'un chantier.
   *
   * Les tables NON paranoid (medias, reserve_positions, reserve_historiques,
   * checklists avant migration, chantier_membres) sont volontairement laissées
   * intactes : elles portent la traçabilité et les fichiers, et un `restore()`
   * du chantier doit les retrouver. Les fichiers sur disque ne sont donc PAS
   * supprimés ici — un soft delete est réversible (cf. audit § 5 : seuls les
   * effacements DÉFINITIFS appellent deleteFile).
   */
  static async _supprimerDescendance(chantierId, transaction) {
    const parChantier = { where: { chantierId }, transaction };

    // ── Réserves et leurs filles ────────────────────────────────────────────
    const reserves = await Reserve.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const reserveIds = reserves.map((r) => r.id);
    if (reserveIds.length) {
      const parReserve = { where: { reserveId: { [Op.in]: reserveIds } }, transaction };
      await Commentaire.destroy(parReserve);
      await PieceJointe.destroy(parReserve);
      await Reserve.destroy(parChantier);
    }

    // ── Plans et leurs annotations ──────────────────────────────────────────
    const plans = await Plan.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const planIds = plans.map((p) => p.id);
    if (planIds.length) {
      await Annotation.destroy({ where: { planId: { [Op.in]: planIds } }, transaction });
      await Plan.destroy(parChantier);
    }

    // ── Inspections et leurs checklists ─────────────────────────────────────
    const inspections = await Inspection.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const inspectionIds = inspections.map((i) => i.id);
    if (inspectionIds.length) {
      await Checklist.destroy({ where: { inspectionId: { [Op.in]: inspectionIds } }, transaction });
      await Inspection.destroy(parChantier);
    }

    // ── Structure : bâtiments → étages → zones ──────────────────────────────
    const batiments = await Batiment.findAll({
      where: { chantierId }, attributes: ['id'], raw: true, transaction,
    });
    const batimentIds = batiments.map((b) => b.id);
    if (batimentIds.length) {
      const etages = await Etage.findAll({
        where: { batimentId: { [Op.in]: batimentIds } }, attributes: ['id'], raw: true, transaction,
      });
      const etageIds = etages.map((e) => e.id);
      let zoneIds = [];
      if (etageIds.length) {
        const zones = await Zone.findAll({
          where: { etageId: { [Op.in]: etageIds } }, attributes: ['id'], raw: true, transaction,
        });
        zoneIds = zones.map((z) => z.id);
      }

      // Les hotspots pointent vers la structure par une association POLYMORPHE
      // (cible_type + cible_id), qu'aucune clé étrangère ne peut couvrir : sans
      // ce nettoyage explicite, le plan global gardait des zones cliquables
      // menant vers des bâtiments détruits. Voir planHotspot.model.js.
      await _supprimerHotspotsDeLaStructure(
        { batimentIds, etageIds, zoneIds },
        transaction
      );

      if (etageIds.length) {
        await Zone.destroy({ where: { etageId: { [Op.in]: etageIds } }, transaction });
        await Etage.destroy({ where: { batimentId: { [Op.in]: batimentIds } }, transaction });
      }
      await Batiment.destroy(parChantier);
    }

    // ── Reste des entités rattachées au chantier ────────────────────────────
    await Lot.destroy(parChantier);
    await Document.destroy(parChantier);
    await Phase.destroy(parChantier);
    await Rapport.destroy(parChantier);
  }

  // -------------------- STRUCTURE (bâtiments / étages / zones) --------------------
  static async creerBatiment(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const batiment = await Batiment.create({
      chantierId,
      nom: data.nom,
      code: data.code || null,
    });
    return { success: true, message: 'Bâtiment créé avec succès', batiment };
  }

  static async creerEtage(organisationId, chantierId, batimentId, data) {
    // Le bâtiment doit appartenir au chantier ET à l'organisation
    const batiment = await Batiment.findOne({
      where: { id: batimentId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
    });
    if (!batiment) return { success: false, message: 'Bâtiment introuvable dans ce chantier' };

    const etage = await Etage.create({
      batimentId,
      nom: data.nom,
      niveau: data.niveau ?? 0,
      // Nature du niveau : c'est elle qui range l'étage sous « SOUS-SOLS »,
      // « ÉTAGES » ou « TOITURE ». Absente, le modèle applique 'etage'.
      ...(data.typeNiveau ? { typeNiveau: data.typeNiveau } : {}),
      codeNiveau: data.codeNiveau || null,
      description: data.description || null,
    });
    return { success: true, message: 'Étage créé avec succès', etage };
  }

  static async creerZone(organisationId, chantierId, batimentId, etageId, data) {
    const etage = await Etage.findOne({
      where: { id: etageId, batimentId },
      include: [{
        model: Batiment,
        as: 'batiment',
        where: { chantierId },
        include: [{ model: Chantier, as: 'chantier', where: { organisationId } }],
      }],
    });
    if (!etage) return { success: false, message: 'Étage introuvable dans ce bâtiment' };

    const zone = await Zone.create({
      etageId,
      nom: data.nom,
      type: data.type || 'zone',
    });
    return { success: true, message: 'Zone créée avec succès', zone };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  MODIFICATION & SUPPRESSION DE LA STRUCTURE
  //
  //  Il n'existait que la création : un bâtiment mal nommé restait mal nommé,
  //  et une zone créée par erreur restait dans l'arborescence à jamais — donc
  //  dans les sélecteurs de localisation de chaque réserve.
  //
  //  RÈGLE DE SUPPRESSION — on REFUSE tant qu'une réserve pointe sur
  //  l'élément ou sur l'un de ses descendants, et on dit combien.
  //
  //  Une réserve est une pièce contradictoire : elle atteste d'un défaut à un
  //  endroit précis, et les PV de réception s'y adossent. Effacer sa
  //  localisation — même en douceur — reviendrait à réécrire après coup ce
  //  qui a été constaté. Refuser oblige à traiter ou déplacer les réserves
  //  d'abord, ce qui est une décision métier, pas un effet de bord.
  //
  //  Les PLANS, eux, sont simplement DÉTACHÉS (leur rattachement repasse à
  //  null) : le document reste consultable et remonte d'un niveau, ce qui est
  //  exactement ce qui doit arriver au plan d'un étage supprimé.
  //
  //  Les HOTSPOTS visant l'élément sont effacés : leur cible n'existant plus,
  //  ils laisseraient sur le plan une pastille qui ne mène nulle part — pire
  //  qu'une absence de repère.
  //
  //  Tous les modèles sont `paranoid` : `destroy()` fait un soft delete, et
  //  les CASCADE de clés étrangères ne se déclenchent PAS dans ce cas. La
  //  descente bâtiment → étages → zones est donc explicite.
  // ════════════════════════════════════════════════════════════════════════

  /** Bâtiment du chantier, lui-même dans l'organisation. */
  static async _batimentCadre(organisationId, chantierId, batimentId) {
    return Batiment.findOne({
      where: { id: batimentId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'] }],
    });
  }

  /** Étage du bâtiment, lui-même dans le chantier et l'organisation. */
  static async _etageCadre(organisationId, chantierId, batimentId, etageId) {
    return Etage.findOne({
      where: { id: etageId, batimentId },
      include: [{
        model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true,
        include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'], required: true }],
      }],
    });
  }

  /** Zone de l'étage, lui-même dans le bâtiment, le chantier et l'organisation. */
  static async _zoneCadre(organisationId, chantierId, batimentId, etageId, zoneId) {
    return Zone.findOne({
      where: { id: zoneId, etageId },
      include: [{
        model: Etage, as: 'etage', where: { batimentId }, attributes: ['id'], required: true,
        include: [{
          model: Batiment, as: 'batiment', where: { chantierId }, attributes: ['id'], required: true,
          include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: ['id'], required: true }],
        }],
      }],
    });
  }

  /**
   * Nombre de réserves accrochées à l'un des niveaux visés.
   *
   * `Op.or` sur les trois colonnes plutôt que trois requêtes : une réserve
   * posée sur un appartement porte AUSSI son étage et son bâtiment, mais une
   * réserve créée depuis la liste peut n'avoir que le bâtiment. Ne regarder
   * qu'une colonne laisserait passer l'autre cas.
   */
  static async _compterReservesLiees({ batimentIds = [], etageIds = [], zoneIds = [] }) {
    const conditions = [];
    if (batimentIds.length) conditions.push({ batimentId: { [Op.in]: batimentIds } });
    if (etageIds.length) conditions.push({ etageId: { [Op.in]: etageIds } });
    if (zoneIds.length) conditions.push({ zoneId: { [Op.in]: zoneIds } });
    if (!conditions.length) return 0;
    return Reserve.count({ where: { [Op.or]: conditions } });
  }

  /** Détache les plans des niveaux supprimés — le document survit à sa zone. */
  static async _detacherPlans({ batimentIds = [], etageIds = [], zoneIds = [] }, transaction) {
    if (zoneIds.length) {
      await Plan.update({ zoneId: null }, { where: { zoneId: { [Op.in]: zoneIds } }, transaction });
    }
    if (etageIds.length) {
      await Plan.update({ etageId: null }, { where: { etageId: { [Op.in]: etageIds } }, transaction });
    }
    if (batimentIds.length) {
      await Plan.update({ batimentId: null }, { where: { batimentId: { [Op.in]: batimentIds } }, transaction });
    }
  }

  /** Message de refus, avec le nombre de réserves qui bloquent. */
  static _refusReserves(nombre) {
    return {
      success: false,
      message: nombre === 1
        ? '1 réserve est rattachée à cet élément. Déplacez-la ou supprimez-la avant.'
        : `${nombre} réserves sont rattachées à cet élément. Déplacez-les ou supprimez-les avant.`,
    };
  }

  // -------------------- BÂTIMENT --------------------
  static async modifierBatiment(organisationId, chantierId, batimentId, data) {
    const batiment = await ChantierService._batimentCadre(organisationId, chantierId, batimentId);
    if (!batiment) return { success: false, message: 'Bâtiment introuvable dans ce chantier' };

    const updates = {};
    if (data.nom !== undefined) updates.nom = data.nom;
    if (data.code !== undefined) updates.code = data.code || null;
    await batiment.update(updates);

    return { success: true, message: 'Bâtiment modifié avec succès', batiment };
  }

  static async supprimerBatiment(organisationId, chantierId, batimentId) {
    const batiment = await ChantierService._batimentCadre(organisationId, chantierId, batimentId);
    if (!batiment) return { success: false, message: 'Bâtiment introuvable dans ce chantier' };

    const etages = await Etage.findAll({ where: { batimentId }, attributes: ['id'], raw: true });
    const etageIds = etages.map((e) => e.id);
    const zones = etageIds.length
      ? await Zone.findAll({ where: { etageId: { [Op.in]: etageIds } }, attributes: ['id'], raw: true })
      : [];
    const zoneIds = zones.map((z) => z.id);
    const cibles = { batimentIds: [batimentId], etageIds, zoneIds };

    const nbReserves = await ChantierService._compterReservesLiees(cibles);
    if (nbReserves > 0) return ChantierService._refusReserves(nbReserves);

    const t = await sequelize.transaction();
    try {
      await _supprimerHotspotsDeLaStructure(cibles, t);
      await ChantierService._detacherPlans(cibles, t);
      if (zoneIds.length) await Zone.destroy({ where: { id: { [Op.in]: zoneIds } }, transaction: t });
      if (etageIds.length) await Etage.destroy({ where: { id: { [Op.in]: etageIds } }, transaction: t });
      await batiment.destroy({ transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Bâtiment supprimé avec succès' };
  }

  // -------------------- ÉTAGE --------------------
  static async modifierEtage(organisationId, chantierId, batimentId, etageId, data) {
    const etage = await ChantierService._etageCadre(organisationId, chantierId, batimentId, etageId);
    if (!etage) return { success: false, message: 'Étage introuvable dans ce bâtiment' };

    const updates = {};
    if (data.nom !== undefined) updates.nom = data.nom;
    if (data.niveau !== undefined) updates.niveau = data.niveau;
    await etage.update(updates);

    return { success: true, message: 'Étage modifié avec succès', etage };
  }

  static async supprimerEtage(organisationId, chantierId, batimentId, etageId) {
    const etage = await ChantierService._etageCadre(organisationId, chantierId, batimentId, etageId);
    if (!etage) return { success: false, message: 'Étage introuvable dans ce bâtiment' };

    const zones = await Zone.findAll({ where: { etageId }, attributes: ['id'], raw: true });
    const zoneIds = zones.map((z) => z.id);
    const cibles = { etageIds: [etageId], zoneIds };

    const nbReserves = await ChantierService._compterReservesLiees(cibles);
    if (nbReserves > 0) return ChantierService._refusReserves(nbReserves);

    const t = await sequelize.transaction();
    try {
      await _supprimerHotspotsDeLaStructure(cibles, t);
      await ChantierService._detacherPlans(cibles, t);
      if (zoneIds.length) await Zone.destroy({ where: { id: { [Op.in]: zoneIds } }, transaction: t });
      await etage.destroy({ transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Étage supprimé avec succès' };
  }

  // -------------------- ZONE --------------------
  static async modifierZone(organisationId, chantierId, batimentId, etageId, zoneId, data) {
    const zone = await ChantierService._zoneCadre(organisationId, chantierId, batimentId, etageId, zoneId);
    if (!zone) return { success: false, message: 'Zone introuvable dans cet étage' };

    const updates = {};
    if (data.nom !== undefined) updates.nom = data.nom;
    if (data.type !== undefined) updates.type = data.type;
    await zone.update(updates);

    return { success: true, message: 'Zone modifiée avec succès', zone };
  }

  static async supprimerZone(organisationId, chantierId, batimentId, etageId, zoneId) {
    const zone = await ChantierService._zoneCadre(organisationId, chantierId, batimentId, etageId, zoneId);
    if (!zone) return { success: false, message: 'Zone introuvable dans cet étage' };

    const cibles = { zoneIds: [zoneId] };

    const nbReserves = await ChantierService._compterReservesLiees(cibles);
    if (nbReserves > 0) return ChantierService._refusReserves(nbReserves);

    const t = await sequelize.transaction();
    try {
      await _supprimerHotspotsDeLaStructure(cibles, t);
      await ChantierService._detacherPlans(cibles, t);
      await zone.destroy({ transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Zone supprimée avec succès' };
  }

  // -------------------- LOTS --------------------
  static async creerLot(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const lot = await Lot.create({
      chantierId,
      nom: data.nom,
      code: data.code || null,
      corps_d_etat: data.corps_d_etat || null,
    });
    return { success: true, message: 'Lot créé avec succès', lot };
  }

  static async listLots(organisationId, chantierId) {
    const lots = await Lot.findAll({
      where: { chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
      order: [['nom', 'ASC']],
    });
    return { success: true, lots };
  }

  // -------------------- AFFECTATION DES MEMBRES AU CHANTIER (module 1) --------------------
  /** Affecte un ou plusieurs membres de l'organisation à un chantier. */
  static async assignerMembres(organisationId, chantierId, membreIds, roleChantier = null) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const membres = await Utilisateur.findAll({ where: { id: membreIds, organisationId } });
    if (membres.length !== membreIds.length) {
      return { success: false, message: 'Certains membres ne font pas partie de cette organisation' };
    }

    await chantier.addMembres(membres.map((m) => m.id));

    // Mettre à jour le rôle sur le chantier (si précisé)
    if (roleChantier) {
      await ChantierMembre.update(
        { roleChantier },
        { where: { chantierId, utilisateurId: membreIds } }
      );
    }

    // Notifier les membres affectés (module 8)
    for (const m of membres) {
      await NotificationService.notifier({
        utilisateurId: m.id,
        type: 'chantier.affectation',
        titre: 'Affectation chantier',
        message: `Vous avez été affecté(e) au chantier « ${chantier.nom} »${roleChantier ? ` (${roleChantier})` : ''}.`,
        donnees: { chantierId },
      });
    }

    return { success: true, message: 'Membres affectés au chantier' };
  }

  /** Liste les membres affectés à un chantier. */
  /** L'email des intervenants n'est exposé qu'aux rôles de gestion. */
  static async listMembresChantier(organisationId, chantierId, role = null) {
    const peutVoirEmails = role === 'Admin' || GESTION.includes(role);
    const attributs = peutVoirEmails
      ? ['id', 'nom', 'prenom', 'email', 'role', 'photoProfil']
      : ['id', 'nom', 'prenom', 'role', 'photoProfil'];

    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [{
        model: Utilisateur,
        as: 'membres',
        attributes: attributs,
        through: { attributes: ['roleChantier'] },
      }],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };
    return { success: true, membres: chantier.membres };
  }

  /** Retire un membre d'un chantier. */
  static async retirerMembreChantier(organisationId, chantierId, membreId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    await chantier.removeMembres(membreId);
    return { success: true, message: 'Membre retiré du chantier' };
  }

  /** Projets d'un utilisateur (affectations) — accessible via /account/chantiers. */
  static async listChantiersUtilisateur(utilisateurId, organisationId) {
    const chantiers = await Chantier.findAll({
      where: { organisationId },
      include: [{
        model: Utilisateur,
        as: 'membres',
        where: { id: utilisateurId },
        required: true,
        attributes: [],
        through: { attributes: ['roleChantier'] },
      }],
      order: [['createdAt', 'DESC']],
    });
    return { success: true, chantiers };
  }

  // -------------------- DUPLICATION D'UN CHANTIER (module 3) --------------------
  /**
   * Copie le chantier et toute sa décomposition (bâtiments → étages → zones,
   * lots). Les réserves, plans et documents ne sont PAS dupliqués
   * (chaque réserve est liée à une position et une version de plan).
   */
  static async dupliquerChantier(organisationId, chantierId, { nom = null } = {}) {
    const chantier = await Chantier.findOne({
      where: { id: chantierId, organisationId },
      include: [
        {
          model: Batiment, as: 'batiments',
          include: [{ model: Etage, as: 'etages', include: [{ model: Zone, as: 'zones' }] }],
        },
        { model: Lot, as: 'lots' },
      ],
    });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    // CORRECTIF (audit § 2) — duplication atomique.
    // Sans transaction, un échec au 3ᵉ bâtiment (contrainte, coupure DB…)
    // laissait un chantier à moitié construit : l'appelant recevait une 500 et
    // pouvait relancer, créant un second squelette incomplet. La copie est
    // désormais tout ou rien.
    const t = await sequelize.transaction();
    let nouveauChantier;
    try {
      nouveauChantier = await Chantier.create({
        organisationId,
        code: `CH-${Math.random().toString(16).slice(2, 6).toUpperCase()}`,
        nom: nom || `${chantier.nom} (copie)`,
        description: chantier.description,
        adresse: chantier.adresse,
        latitude: chantier.latitude,
        longitude: chantier.longitude,
        date_debut: chantier.date_debut,
        date_fin: chantier.date_fin,
        responsableId: chantier.responsableId,
        budget: chantier.budget,
        statut: 'en_preparation',
      }, { transaction: t });

      // Bâtiments → étages → zones
      for (const batiment of chantier.batiments || []) {
        const newBat = await Batiment.create(
          { chantierId: nouveauChantier.id, nom: batiment.nom, code: batiment.code },
          { transaction: t }
        );
        for (const etage of batiment.etages || []) {
          const newEtage = await Etage.create(
            { batimentId: newBat.id, nom: etage.nom, niveau: etage.niveau },
            { transaction: t }
          );
          for (const zone of etage.zones || []) {
            await Zone.create(
              { etageId: newEtage.id, nom: zone.nom, type: zone.type },
              { transaction: t }
            );
          }
        }
      }

      // Lots
      for (const lot of chantier.lots || []) {
        await Lot.create({
          chantierId: nouveauChantier.id,
          nom: lot.nom, code: lot.code, corps_d_etat: lot.corps_d_etat,
        }, { transaction: t });
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    return { success: true, message: 'Chantier dupliqué avec succès', chantier: nouveauChantier };
  }

  // -------------------- PHASES & PLANNING (module 3) --------------------
  static async creerPhase(organisationId, chantierId, data) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const phase = await Phase.create({
      chantierId,
      nom: data.nom,
      description: data.description || null,
      ordre: data.ordre || 0,
      date_debut: data.date_debut || null,
      date_fin: data.date_fin || null,
      statut: data.statut || 'planifiee',
    });
    return { success: true, message: 'Phase créée avec succès', phase };
  }

  static async listPhases(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const phases = await Phase.findAll({ where: { chantierId }, order: [['ordre', 'ASC']] });
    return { success: true, phases };
  }

  static async modifierPhase(organisationId, chantierId, phaseId, data) {
    const phase = await Phase.findOne({
      where: { id: phaseId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
    });
    if (!phase) return { success: false, message: 'Phase introuvable' };

    const updates = {};
    for (const champ of ['nom', 'description', 'ordre', 'date_debut', 'date_fin', 'statut']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    await phase.update(updates);
    return { success: true, message: 'Phase mise à jour', phase };
  }

  static async supprimerPhase(organisationId, chantierId, phaseId) {
    const phase = await Phase.findOne({
      where: { id: phaseId, chantierId },
      include: [{ model: Chantier, as: 'chantier', where: { organisationId }, attributes: [] }],
    });
    if (!phase) return { success: false, message: 'Phase introuvable' };

    await phase.destroy(); // soft delete
    return { success: true, message: 'Phase supprimée' };
  }

  // -------------------- CALENDRIER / PLANNING (module 3) --------------------
  /**
   * Agrège les phases, inspections et échéances de réserves du chantier
   * sous forme d'événements de calendrier.
   */
  static async calendrier(organisationId, chantierId) {
    const chantier = await Chantier.findOne({ where: { id: chantierId, organisationId } });
    if (!chantier) return { success: false, message: 'Chantier introuvable' };

    const [phases, inspections, reserves] = await Promise.all([
      Phase.findAll({ where: { chantierId }, order: [['ordre', 'ASC']] }),
      Inspection.findAll({ where: { chantierId }, attributes: ['id', 'type', 'date_visite', 'statut'] }),
      Reserve.findAll({ where: { chantierId }, attributes: ['id', 'numero', 'titre', 'date_limite', 'statut'] }),
    ]);

    const evenements = [];
    for (const p of phases) {
      evenements.push({
        type: 'phase', id: p.id, titre: p.nom,
        dateDebut: p.date_debut, dateFin: p.date_fin, statut: p.statut,
      });
    }
    for (const i of inspections) {
      if (i.date_visite) {
        evenements.push({
          type: 'inspection', id: i.id,
          titre: `Inspection ${i.type.replace(/_/g, ' ')}`,
          dateDebut: i.date_visite, dateFin: i.date_visite, statut: i.statut,
        });
      }
    }
    for (const r of reserves) {
      if (r.date_limite) {
        evenements.push({
          type: 'reserve', id: r.id,
          titre: `${r.numero} — ${r.titre}`,
          dateDebut: r.date_limite, dateFin: r.date_limite, statut: r.statut,
        });
      }
    }

    evenements.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));

    return { success: true, calendrier: { evenements, phases, inspections } };
  }
}

module.exports = ChantierService;
