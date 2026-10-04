'use strict';

const { Op, QueryTypes } = require('sequelize');
const {
  Devis, Organisation, PlanAbonnement, AbonnementSouscrit, Utilisateur,
} = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const logger = require('../../../utils/logger.js');
const NotificationService = require('../../notification/service/notification.service.js');
const { sendDevisEmail } = require('../../../infrastructure/emailService.js');

/**
 * DEVIS d'abonnement — « Premium sur devis ».
 *
 * ── Le parcours, et ce qui le rend sûr ────────────────────────────────────
 *
 *   demande (client)  →  chiffrage (super-admin)  →  envoi  →  acceptation
 *   (client)  →  session de paiement  →  STRIPE  →  webhook vérifié  →
 *   abonnement actif aux conditions du devis.
 *
 * Deux règles tiennent tout l'édifice :
 *
 *  1. **le client ne chiffre jamais**. Il décrit son besoin ; le montant, la
 *     durée et les limites sont posés par un super-admin et relus EN BASE au
 *     moment de créer la session de paiement. Un montant envoyé par le
 *     navigateur n'a aucun effet — il n'existe même pas de paramètre pour
 *     l'accueillir.
 *
 *  2. **rien n'est activé par un retour de navigateur**. La session de
 *     paiement n'écrit qu'une souscription `en_attente` ; seul le webhook
 *     Stripe, signature vérifiée et montant comparé, la fait passer à
 *     `active`. C'est le mécanisme déjà en place pour le catalogue
 *     (`subscription.service.js`), réutilisé tel quel.
 *
 * ── Ce que le devis fige ──────────────────────────────────────────────────
 *
 * Montant, durée en mois et limites d'usage sont recopiés sur la souscription
 * à sa création. Modifier le devis après coup ne réécrit donc pas un
 * abonnement déjà payé.
 */

/** Statuts depuis lesquels un devis peut encore être chiffré ou modifié. */
const MODIFIABLES = ['brouillon', 'envoye'];

/** Validité par défaut d'une offre chiffrée, faute d'échéance explicite. */
const VALIDITE_JOURS = 30;

/**
 * Échéance d'un contrat, en mois, bornée au dernier jour du mois visé.
 *
 * `setMonth(+n)` déborde : un contrat de 12 mois pris le 31 janvier finirait
 * le 3 mars de l'année suivante. Même raisonnement que `calculerDateFin`
 * dans `subscription.service.js`, pour une durée libre.
 */
function echeance(debut, mois) {
  const d = new Date(debut);
  const cible = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + Number(mois), 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()
  ));
  const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(d.getUTCDate(), dernierJour));
  return cible;
}

/** Arrondi au centime — les montants sont des décimaux, pas des flottants. */
const centimes = (valeur) => Math.round(Number(valeur) * 100) / 100;

/** Vrai si la date de validité est dépassée. */
const perime = (devis) => !!devis.expire_le && new Date(devis.expire_le) < new Date();

/** Vue publique — ce que le client et l'administration lisent. */
function vuePublique(devis) {
  return {
    id: devis.id,
    numero: devis.numero,
    statut: devis.statut,
    organisationId: devis.organisationId,
    planCode: devis.plan_code,
    planNom: devis.plan_nom,
    // `null` = pas encore chiffré. À distinguer de 0, qui serait un devis
    // gratuit — une offre, pas une absence d'offre.
    montantHt: devis.montant_ht === null ? null : Number(devis.montant_ht),
    tauxTva: Number(devis.taux_tva),
    montantTva: devis.montant_tva === null ? null : Number(devis.montant_tva),
    montantTtc: devis.montant_ttc === null ? null : Number(devis.montant_ttc),
    devise: devis.devise,
    dureeMois: devis.duree_mois,
    limiteUtilisateurs: devis.limite_utilisateurs,
    limiteChantiers: devis.limite_chantiers,
    options: devis.options,
    conditions: devis.conditions,
    demande: devis.demande,
    envoyeLe: devis.envoye_le,
    accepteLe: devis.accepte_le,
    refuseLe: devis.refuse_le,
    expireLe: devis.expire_le,
    payeLe: devis.paye_le,
    motifRefus: devis.motif_refus,
    souscriptionId: devis.souscriptionId,
    creeLe: devis.createdAt,
    // Calculés ici pour que les clients n'aient pas à redéduire les règles —
    // et que web et mobile affichent exactement les mêmes boutons.
    chiffre: devis.montant_ttc !== null && devis.montant_ttc !== undefined,
    peutEtreAccepte: devis.statut === 'envoye' && !perime(devis),
    peutEtrePaye: devis.statut === 'accepte' && !perime(devis) && !devis.paye_le,
  };
}

class DevisService {

  // ══════════════════════════════════════════════════════════════════════
  //  NUMÉROTATION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Numéro suivant — `WDJ-<année>-<séquence sur 4 chiffres>`.
   *
   * Reparti à 1 chaque année civile. Le calcul est SÉRIALISÉ par un verrou
   * consultatif porté par la transaction : deux demandes simultanées liraient
   * sinon le même maximum et heurteraient la contrainte d'unicité. Même
   * mécanique que la numérotation des réserves, et pour la même raison.
   */
  static async _prochainNumero(transaction) {
    const annee = new Date().getUTCFullYear();

    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle)) AS verrou', {
      replacements: { cle: `devis:numero:${annee}` },
      type: QueryTypes.SELECT,
      transaction,
    });

    const [ligne] = await sequelize.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '^WDJ-[0-9]{4}-', ''), '')::bigint), 0) AS max
         FROM devis
        WHERE numero LIKE :prefixe`,
      { replacements: { prefixe: `WDJ-${annee}-%` }, type: QueryTypes.SELECT, transaction }
    );

    const suivant = (Number(ligne && ligne.max) || 0) + 1;
    return `WDJ-${annee}-${String(suivant).padStart(4, '0')}`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  CÔTÉ CLIENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Demande de devis (écran 2 du cahier des charges).
   *
   * Le client décrit son besoin ; rien n'est chiffré ici. La demande est
   * conservée BRUTE : c'est elle qui justifiera le chiffrage, et elle ne doit
   * pas se perdre si l'organisation change de contact entre-temps.
   */
  static async demander(organisationId, utilisateurId, data = {}) {
    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    // Une demande en cours suffit : en ouvrir une seconde noierait
    // l'administration et laisserait le client devant deux devis divergents.
    const enCours = await Devis.findOne({
      where: { organisationId, statut: { [Op.in]: ['brouillon', 'envoye'] } },
      order: [['createdAt', 'DESC']],
    });
    if (enCours) {
      return {
        success: false,
        message: enCours.statut === 'envoye'
          ? `Un devis vous a déjà été transmis (${enCours.numero}). Consultez-le pour l'accepter ou le refuser.`
          : `Votre demande de devis ${enCours.numero} est en cours de traitement. Nous revenons vers vous rapidement.`,
        code: 'DEVIS_DEJA_EN_COURS',
        devis: vuePublique(enCours),
      };
    }

    // La formule visée : celle « sur devis » du catalogue, si elle existe.
    // Facultative — le parcours doit rester possible même sans elle.
    const plan = data.planId
      ? await PlanAbonnement.findOne({
        where: /^[0-9a-f-]{36}$/i.test(String(data.planId)) ? { id: data.planId } : { code: data.planId },
      })
      : await PlanAbonnement.findOne({ where: { actif: true, prix: null }, order: [['ordre', 'ASC']] });

    const devis = await sequelize.transaction(async (t) => {
      const numero = await DevisService._prochainNumero(t);
      return Devis.create({
        organisationId,
        numero,
        statut: 'brouillon',
        planAbonnementId: plan ? plan.id : null,
        plan_code: plan ? plan.code : null,
        plan_nom: plan ? plan.nom : null,
        devise: plan ? plan.devise : 'EUR',
        demande: {
          societe: data.societe || org.nom,
          siren: data.siren || org.siret || null,
          contact: data.contact || null,
          email: data.email || org.email || null,
          telephone: data.telephone || org.telephone || null,
          nbUtilisateurs: data.nbUtilisateurs ?? null,
          nbChantiers: data.nbChantiers ?? null,
          dureeSouhaitee: data.dureeSouhaitee ?? null,
          besoins: data.besoins || null,
        },
        demande_par: utilisateurId || null,
      }, { transaction: t });
    });

    logger.info(`[devis] Demande ${devis.numero} reçue pour l'organisation ${organisationId}`);
    // Best-effort : une notification perdue ne doit pas faire échouer une
    // demande commerciale déjà enregistrée.
    await DevisService._prevenirAdministration(devis, org);

    return { success: true, devis: vuePublique(devis) };
  }

  /** Devis d'une organisation, du plus récent au plus ancien. */
  static async lister(organisationId) {
    const lignes = await Devis.findAll({
      where: { organisationId },
      order: [['createdAt', 'DESC']],
    });
    // Un devis dont la validité est passée se referme à la lecture : pas de
    // tâche planifiée à surveiller, et l'état affiché est toujours le vrai.
    await Promise.all(lignes.map((d) => DevisService._perimerSiBesoin(d)));
    return { success: true, devis: lignes.map(vuePublique) };
  }

  /** Un devis précis, cloisonné à son organisation. */
  static async obtenir(organisationId, devisId) {
    const devis = await Devis.findOne({ where: { id: devisId, organisationId } });
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };
    await DevisService._perimerSiBesoin(devis);
    return { success: true, devis: vuePublique(devis) };
  }

  /**
   * Acceptation par le client (écran 3).
   *
   * Un devis non chiffré, déjà traité ou périmé ne s'accepte pas : accepter
   * reviendrait sinon à s'engager sur un montant inexistant ou sur une offre
   * qui n'est plus la nôtre.
   */
  static async accepter(organisationId, devisId) {
    const devis = await Devis.findOne({ where: { id: devisId, organisationId } });
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };
    if (await DevisService._perimerSiBesoin(devis)) {
      return { success: false, message: 'Ce devis a expiré. Demandez-nous une nouvelle proposition.' };
    }
    if (devis.statut === 'accepte') return { success: true, devis: vuePublique(devis) };
    if (devis.statut !== 'envoye') {
      return { success: false, message: "Ce devis n'est pas en attente de votre réponse." };
    }

    await devis.update({ statut: 'accepte', accepte_le: new Date() });
    logger.info(`[devis] ${devis.numero} accepté par l'organisation ${organisationId}`);
    return { success: true, devis: vuePublique(devis) };
  }

  /** Refus par le client, avec son motif — qui nous sert à reformuler. */
  static async refuser(organisationId, devisId, motif = null) {
    const devis = await Devis.findOne({ where: { id: devisId, organisationId } });
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };
    if (!['envoye', 'brouillon'].includes(devis.statut)) {
      return { success: false, message: "Ce devis n'est plus en attente de votre réponse." };
    }

    await devis.update({ statut: 'refuse', refuse_le: new Date(), motif_refus: motif || null });
    logger.info(`[devis] ${devis.numero} refusé par l'organisation ${organisationId}`);
    return { success: true, devis: vuePublique(devis) };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  CÔTÉ ADMINISTRATION
  // ══════════════════════════════════════════════════════════════════════

  /** Tous les devis, filtrables — tableau de bord de l'administration. */
  static async listerTout({ statut, organisationId, limit = 50, offset = 0 } = {}) {
    const where = {};
    if (statut) where.statut = statut;
    if (organisationId) where.organisationId = organisationId;

    const { rows, count } = await Devis.findAndCountAll({
      where,
      include: [{ model: Organisation, as: 'organisation', attributes: ['id', 'nom', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    return {
      success: true,
      devis: rows.map((d) => ({
        ...vuePublique(d),
        organisation: d.organisation
          ? { id: d.organisation.id, nom: d.organisation.nom, email: d.organisation.email }
          : null,
      })),
      total: count,
    };
  }

  /**
   * Chiffrage par le super-admin (étape B).
   *
   * La TVA et le TTC sont CALCULÉS ici à partir du HT et du taux : les faire
   * saisir inviterait l'erreur de frappe, et c'est le TTC qui sera débité.
   */
  static async preparer(devisId, adminId, data = {}) {
    const devis = await Devis.findByPk(devisId);
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };
    if (!MODIFIABLES.includes(devis.statut)) {
      return {
        success: false,
        message: `Un devis ${devis.statut} ne se modifie plus. Établissez-en un nouveau.`,
      };
    }

    const montantHt = centimes(data.montantHt);
    const tauxTva = data.tauxTva === undefined || data.tauxTva === null ? Number(devis.taux_tva) : Number(data.tauxTva);
    const montantTva = centimes(montantHt * tauxTva / 100);

    await devis.update({
      montant_ht: montantHt,
      taux_tva: tauxTva,
      montant_tva: montantTva,
      montant_ttc: centimes(montantHt + montantTva),
      devise: (data.devise || devis.devise || 'EUR').toUpperCase(),
      duree_mois: data.dureeMois,
      // `undefined` laisse la valeur en place, `null` signifie ILLIMITÉ : les
      // confondre plafonnerait un contrat qui ne devait pas l'être.
      limite_utilisateurs: data.limiteUtilisateurs === undefined ? devis.limite_utilisateurs : data.limiteUtilisateurs,
      limite_chantiers: data.limiteChantiers === undefined ? devis.limite_chantiers : data.limiteChantiers,
      options: data.options === undefined ? devis.options : data.options,
      conditions: data.conditions === undefined ? devis.conditions : data.conditions,
      expire_le: data.expireLe
        ? new Date(data.expireLe)
        : devis.expire_le || new Date(Date.now() + VALIDITE_JOURS * 24 * 60 * 60 * 1000),
      prepare_par: adminId || null,
    });

    logger.info(`[devis] ${devis.numero} chiffré à ${devis.montant_ttc} ${devis.devise} par ${adminId}`);
    return { success: true, devis: vuePublique(devis) };
  }

  /**
   * Envoi au client (étape B → C).
   *
   * Un devis sans montant ni durée ne s'envoie pas : le client ne pourrait ni
   * l'accepter ni le payer, et il n'y verrait qu'une page vide.
   */
  static async envoyer(devisId, adminId) {
    const devis = await Devis.findByPk(devisId);
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };
    if (!MODIFIABLES.includes(devis.statut)) {
      return { success: false, message: `Un devis ${devis.statut} ne se renvoie pas.` };
    }
    if (devis.montant_ttc === null || devis.montant_ttc === undefined || !devis.duree_mois) {
      return { success: false, message: 'Chiffrez le montant et la durée avant d’envoyer le devis.' };
    }

    await devis.update({ statut: 'envoye', envoye_le: new Date(), prepare_par: devis.prepare_par || adminId });
    logger.info(`[devis] ${devis.numero} envoyé à l'organisation ${devis.organisationId}`);
    await DevisService._prevenirClient(devis);

    return { success: true, devis: vuePublique(devis) };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PAIEMENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Session de paiement d'un devis accepté (étape D).
   *
   * Le montant vient de la BASE — `montant_ttc`, posé par le super-admin. La
   * souscription naît `en_attente`, référencée par la session : elle
   * n'accorde AUCUN droit tant que le webhook n'a pas confirmé
   * l'encaissement, et c'est le montant encaissé qui sera comparé à
   * celui-ci.
   *
   * @param {(params: object) => Promise<object>} creerSession Injecté par
   *   `SubscriptionService` : c'est lui qui connaît Stripe. Ce service ne
   *   parle que de devis.
   */
  static async preparerPaiement(organisationId, devisId, utilisateurId, creerSession) {
    const devis = await Devis.findOne({ where: { id: devisId, organisationId } });
    if (!devis) return { success: false, message: 'Devis introuvable', statusCode: 404 };

    // `perime` et non `_perimerSiBesoin` : un devis ACCEPTÉ garde son statut
    // — il l'a bien été, en temps voulu — mais il ne se paie plus passé sa
    // validité. Un prix négocié il y a six mois n'engage plus, même accepté.
    if (perime(devis)) {
      return { success: false, message: 'Ce devis a expiré. Demandez-nous une nouvelle proposition.' };
    }
    if (devis.statut !== 'accepte') {
      return { success: false, message: 'Acceptez le devis avant de procéder au paiement.' };
    }
    if (devis.paye_le) {
      return { success: false, message: 'Ce devis a déjà été réglé.' };
    }

    const montant = Number(devis.montant_ttc);
    if (!Number.isFinite(montant) || montant <= 0) {
      return { success: false, message: 'Ce devis ne porte aucun montant à régler.' };
    }

    // Un paiement déjà engagé et non abouti : on ne crée pas une seconde
    // session, on rend la première. Deux sessions ouvertes, ce sont deux
    // encaissements possibles pour un seul contrat.
    const enAttente = await AbonnementSouscrit.findOne({
      where: { devisId: devis.id, statut: 'en_attente' },
      order: [['createdAt', 'DESC']],
    });

    const session = await creerSession({
      devis,
      montant,
      // Souscription déjà ouverte : la session Stripe est recréée, mais la
      // ligne en attente est RÉUTILISÉE (sa référence est mise à jour).
      souscriptionExistante: enAttente,
      utilisateurId,
    });

    return { success: true, ...session, devis: vuePublique(devis) };
  }

  /**
   * Devis réglé — appelé par le webhook, une fois l'encaissement confirmé.
   *
   * Idempotent : un événement rejoué ne réécrit pas la date de paiement.
   */
  static async marquerPaye(devisId, souscriptionId) {
    const devis = await Devis.findByPk(devisId);
    if (!devis || devis.paye_le) return;
    await devis.update({ paye_le: new Date(), souscriptionId: souscriptionId || devis.souscriptionId });
    logger.info(`[devis] ${devis.numero} réglé — abonnement ${souscriptionId}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INTERNES
  // ══════════════════════════════════════════════════════════════════════

  /** Échéance d'un contrat issu de ce devis, à partir de sa date de début. */
  static echeanceContrat(debut, dureeMois) {
    return echeance(debut, dureeMois);
  }

  /**
   * Referme un devis dont la validité est passée. Rend `true` s'il est
   * désormais périmé — accepté ou refusé, il ne l'est jamais.
   */
  static async _perimerSiBesoin(devis) {
    if (!['brouillon', 'envoye'].includes(devis.statut)) return false;
    if (!perime(devis)) return false;
    await devis.update({ statut: 'expire' });
    return true;
  }

  /**
   * Prévient les super-admins qu'une demande attend un chiffrage, ET accuse
   * réception au client.
   *
   * Les deux par notification ET par courriel : une demande commerciale qui
   * dort trois jours parce que personne n'a ouvert l'application coûte une
   * vente. Best-effort de bout en bout — la demande est déjà enregistrée,
   * rien de ce qui suit ne doit la faire échouer.
   */
  static async _prevenirAdministration(devis, organisation) {
    const donnees = { devisId: devis.id, numero: devis.numero, organisationId: organisation.id };

    try {
      const admins = await Utilisateur.findAll({
        where: { role: 'Admin', statut: 'actif' },
        attributes: ['id', 'email'],
      });

      await Promise.all(admins.map((a) => NotificationService.notifier({
        utilisateurId: a.id,
        type: 'devis_demande',
        titre: 'Nouvelle demande de devis',
        message: `${organisation.nom} demande une proposition (${devis.numero}).`,
        donnees,
      })));

      // Un seul envoi pour tous les super-admins : `sendEmail` accepte une
      // liste, et la demande doit atteindre celui qui est disponible.
      const adresses = admins.map((a) => a.email).filter(Boolean);
      if (adresses.length > 0) {
        await sendDevisEmail({
          to: adresses,
          variante: 'demande',
          numero: devis.numero,
          organisationNom: organisation.nom,
          demande: devis.demande || {},
        });
      }
    } catch (err) {
      logger.warn(`[devis] Alerte de la demande ${devis.numero} impossible : ${err.message}`);
    }

    await DevisService._accuserReception(devis, organisation);
  }

  /**
   * Accuse réception au client.
   *
   * Sans ce message, la demande part dans le silence : l'utilisateur ne sait
   * pas si elle est arrivée, et il recommence ou appelle.
   */
  static async _accuserReception(devis, organisation) {
    try {
      const destinataire = devis.demande?.email
        || (devis.demande_par
          ? (await Utilisateur.findByPk(devis.demande_par, { attributes: ['email'] }))?.email
          : null)
        || organisation.email;
      if (!destinataire) return;

      await sendDevisEmail({
        to: destinataire,
        variante: 'accuse',
        numero: devis.numero,
        prenom: devis.demande?.contact || null,
        organisationNom: organisation.nom,
      });
    } catch (err) {
      logger.warn(`[devis] Accusé de réception ${devis.numero} impossible : ${err.message}`);
    }
  }

  /**
   * Prévient le demandeur que sa proposition est disponible — notification
   * ET courriel.
   *
   * C'est le message le plus important du parcours : un devis qu'on attend
   * et qui arrive sans prévenir reste à prendre la poussière. Le courriel
   * porte le MONTANT, parce que c'est l'information qu'on attend d'un devis
   * et que la cacher pour forcer l'ouverture de l'application serait un
   * procédé. Il ne porte PAS de bouton « accepter » : une acceptation
   * engage, elle se fait dans le produit, authentifiée.
   */
  static async _prevenirClient(devis) {
    const donnees = { devisId: devis.id, numero: devis.numero };

    try {
      if (devis.demande_par) {
        await NotificationService.notifier({
          utilisateurId: devis.demande_par,
          type: 'devis_envoye',
          titre: 'Votre devis est disponible',
          message: `Le devis ${devis.numero} vous attend : ${devis.montant_ttc} ${devis.devise} `
            + `pour ${devis.duree_mois} mois.`,
          donnees,
        });
      }
    } catch (err) {
      logger.warn(`[devis] Notification du devis ${devis.numero} impossible : ${err.message}`);
    }

    try {
      const organisation = await Organisation.findByPk(devis.organisationId, {
        attributes: ['id', 'nom', 'email'],
      });
      // L'adresse SAISIE dans la demande d'abord : c'est celle de
      // l'interlocuteur commercial, qui n'est pas toujours celle du compte.
      const destinataire = devis.demande?.email
        || (devis.demande_par
          ? (await Utilisateur.findByPk(devis.demande_par, { attributes: ['email'] }))?.email
          : null)
        || organisation?.email;
      if (!destinataire) {
        logger.warn(`[devis] Aucune adresse pour le devis ${devis.numero} — courriel non envoyé`);
        return;
      }

      await sendDevisEmail({
        to: destinataire,
        variante: 'pret',
        numero: devis.numero,
        prenom: devis.demande?.contact || null,
        organisationNom: organisation?.nom || null,
        montantTtc: `${Number(devis.montant_ttc)} ${devis.devise}`,
        dureeMois: devis.duree_mois,
        limiteUtilisateurs: devis.limite_utilisateurs,
        validiteJusquau: devis.expire_le
          ? new Date(devis.expire_le).toLocaleDateString('fr-FR')
          : null,
      });
    } catch (err) {
      logger.warn(`[devis] Courriel du devis ${devis.numero} impossible : ${err.message}`);
    }
  }
}

module.exports = DevisService;
module.exports.vuePublique = vuePublique;
module.exports.echeance = echeance;
module.exports.VALIDITE_JOURS = VALIDITE_JOURS;
