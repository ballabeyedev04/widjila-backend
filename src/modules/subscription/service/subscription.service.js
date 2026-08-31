'use strict';

const Stripe = require('stripe');
const { UniqueConstraintError } = require('sequelize');
const {
  Organisation, PlanAbonnement, AbonnementSouscrit, EvenementPaiement,
} = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');
const DroitsService = require('./droits.service.js');

/**
 * Abonnements et paiement.
 *
 * ── Ce qui a changé, et pourquoi ──────────────────────────────────────────
 * Les formules vivaient dans un objet figé de ce fichier, prix compris
 * (Starter 29 € / Pro 79 € / Business 199 €). Elles vivent désormais en base
 * (`plans_abonnement`), administrables sans livraison. Ce service ne connaît
 * plus aucun tarif.
 *
 * ── Le montant ne vient JAMAIS du client ──────────────────────────────────
 * Le web et le mobile n'envoient qu'un `planId`. Le montant facturé est relu
 * ici depuis la base. Un prix modifié dans le navigateur n'a aucun effet.
 *
 * ── Le paiement n'active rien à lui seul ──────────────────────────────────
 * `creerPaymentIntent` n'écrit qu'une souscription `en_attente`. Seul le
 * WEBHOOK, dont la signature est vérifiée, la fait passer à `active`. Un
 * client qui abandonne le paiement — ou qui appelle l'API directement — ne
 * s'attribue donc rien.
 */

/**
 * Client Stripe initialisé PARESSEUSEMENT.
 *
 * Le constructeur lève « Neither apiKey nor config.authenticator provided »
 * quand la clé est vide. Instancié au chargement du module, il faisait échouer
 * le démarrage complet de l'API sur toute installation sans Stripe configuré.
 */
let stripeClient = null;
let stripeInitialise = false;

function getStripe() {
  if (stripeInitialise) return stripeClient;
  stripeInitialise = true;

  if (!process.env.STRIPE_SECRET_KEY) {
    logger.warn('[stripe] STRIPE_SECRET_KEY non définie — paiements par carte désactivés');
    return null;
  }
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

/** Client Stripe garanti non nul, sinon erreur métier explicite. */
function requireStripe() {
  const client = getStripe();
  if (!client) {
    throw new Error('Paiement par carte indisponible : Stripe n’est pas configuré sur le serveur.');
  }
  return client;
}

/** Représentation publique d'une formule — ce que voient le web et le mobile. */
function vuePublique(plan) {
  const prix = plan.prix === null || plan.prix === undefined ? null : Number(plan.prix);
  return {
    id: plan.id,
    code: plan.code,
    nom: plan.nom,
    description: plan.description,
    // `null` = sur devis. Le client doit pouvoir faire la différence entre
    // « gratuit » et « nous consulter » : renvoyer 0 les confondrait.
    prix,
    devise: plan.devise,
    periode: plan.periode,
    surDevis: prix === null,
    limiteUtilisateurs: plan.limite_utilisateurs,
    limiteChantiers: plan.limite_chantiers,
    fonctionnalites: Array.isArray(plan.fonctionnalites) ? plan.fonctionnalites : [],
    ordre: plan.ordre,
  };
}

/** Échéance d'une période, à partir de sa date de début. */
function calculerDateFin(debut, periode) {
  const fin = new Date(debut);
  if (periode === 'an') fin.setFullYear(fin.getFullYear() + 1);
  else fin.setMonth(fin.getMonth() + 1);
  return fin;
}

class SubscriptionService {

  // ══════════════════════════════════════════════════════════════════════
  //  CATALOGUE
  // ══════════════════════════════════════════════════════════════════════

  /** Formules ACTIVES, dans l'ordre d'affichage — page publique d'abonnement. */
  static async getPlans() {
    const plans = await PlanAbonnement.findAll({
      where: { actif: true },
      order: [['ordre', 'ASC'], ['nom', 'ASC']],
    });
    return plans.map(vuePublique);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ÉTAT DE L'ORGANISATION
  // ══════════════════════════════════════════════════════════════════════

  /** Statut d'abonnement, essai compris. */
  static async getStatus(organisationId) {
    // Compte SANS organisation — le super-admin plateforme, essentiellement.
    //
    // `findByPk(null)` ne trouve rien, et le contrôleur traduisait cette
    // absence en 403. C'était faux à deux titres : le super-admin a bien le
    // droit d'appeler cette route, et il n'a tout simplement pas d'abonnement
    // à déclarer. Résultat : un 403 dans la console à CHAQUE page de l'espace
    // d'administration, puisque la mise en page interroge ce statut partout.
    //
    // On répond donc un statut neutre et valide. Le client sait déjà lire
    // `source: 'aucun'` — c'est ce que renvoie `DroitsService` pour une
    // organisation sans droits.
    if (!organisationId) {
      return {
        success: true,
        status: {
          isSubscribed: false,
          trialEnded: false,
          joursRestantsTrial: 0,
          trialEndsAt: null,
          planActuel: null,
          planCode: null,
          source: 'aucun',
          dateFin: null,
          // Distingue « pas d'abonnement » de « pas concerné » : sans ce
          // drapeau, l'interface afficherait un bandeau « aucun abonnement »
          // à un super-admin qui n'a aucune raison d'en souscrire un.
          sansOrganisation: true,
        },
      };
    }

    const org = await Organisation.findByPk(organisationId, {
      attributes: ['id', 'nom', 'is_subscribed', 'trial_ends_at', 'abonnement'],
    });
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const droits = await DroitsService.getDroits(organisationId);
    const now = new Date();
    const trialEnded = !org.trial_ends_at || new Date(org.trial_ends_at) < now;
    const joursRestants = org.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(org.trial_ends_at) - now) / (1000 * 60 * 60 * 24)))
      : 0;

    return {
      success: true,
      status: {
        isSubscribed: droits.source === 'abonnement',
        trialEnded,
        joursRestantsTrial: joursRestants,
        trialEndsAt: org.trial_ends_at,
        planActuel: droits.planNom,
        planCode: droits.planCode,
        source: droits.source,
        dateFin: droits.dateFin,
      },
    };
  }

  /** État complet : formule courante, droits, usage et catalogue. */
  static async getPlanDetails(organisationId) {
    // Même raison que `getStatus` : un compte sans organisation — le
    // super-admin plateforme — n'a pas de formule, ce n'est pas un refus
    // d'accès. On renvoie le CATALOGUE, qui l'intéresse toujours, et des
    // droits vides plutôt qu'un 403.
    if (!organisationId) {
      return {
        success: true,
        data: {
          droits: await DroitsService.getDroits(null),
          usage: {
            utilisateurs: { courant: 0, limite: 0 },
            chantiers: { courant: 0, limite: 0 },
          },
          souscription: null,
          plans: await SubscriptionService.getPlans(),
          sansOrganisation: true,
        },
      };
    }

    const org = await Organisation.findByPk(organisationId, { attributes: ['id', 'nom'] });
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const [usage, plans, souscription] = await Promise.all([
      DroitsService.getUsage(organisationId),
      SubscriptionService.getPlans(),
      DroitsService.souscriptionActive(organisationId),
    ]);

    return {
      success: true,
      data: {
        droits: usage.droits,
        usage: { utilisateurs: usage.utilisateurs, chantiers: usage.chantiers },
        souscription: souscription ? {
          id: souscription.id,
          planCode: souscription.plan_code,
          planNom: souscription.plan_nom,
          // Le prix RÉELLEMENT payé, figé à la souscription : il ne suit pas
          // les changements de tarif du catalogue.
          prixPaye: souscription.prix_paye === null ? null : Number(souscription.prix_paye),
          devise: souscription.devise,
          periode: souscription.periode,
          statut: souscription.statut,
          dateDebut: souscription.date_debut,
          dateFin: souscription.date_fin,
          fournisseur: souscription.fournisseur,
        } : null,
        plans,
      },
    };
  }

  /** Historique complet des souscriptions d'une organisation. */
  static async getHistorique(organisationId) {
    const souscriptions = await AbonnementSouscrit.findAll({
      where: { organisationId },
      order: [['createdAt', 'DESC']],
    });

    return {
      success: true,
      souscriptions: souscriptions.map((s) => ({
        id: s.id,
        planCode: s.plan_code,
        planNom: s.plan_nom,
        prixPaye: s.prix_paye === null ? null : Number(s.prix_paye),
        devise: s.devise,
        periode: s.periode,
        statut: s.statut,
        dateDebut: s.date_debut,
        dateFin: s.date_fin,
        fournisseur: s.fournisseur,
        creeLe: s.createdAt,
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PAIEMENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Crée une intention de paiement Stripe pour une formule.
   *
   * Le client n'envoie qu'un identifiant : le montant est relu en base. La
   * souscription est créée en `en_attente` — elle ne donne AUCUN droit tant
   * que le webhook n'a pas confirmé l'encaissement.
   *
   * Les données de carte ne transitent jamais par le backend (PCI-DSS) :
   * Stripe les collecte directement depuis le client via le `clientSecret`.
   */
  static async creerPaymentIntent(organisationId, planId) {
    // On accepte l'identifiant OU le code : le mobile et le web manipulent
    // naturellement `essentiel`/`pro`, l'administration des UUID.
    const plan = await PlanAbonnement.findOne({
      where: /^[0-9a-f-]{36}$/i.test(String(planId)) ? { id: planId } : { code: planId },
    });
    if (!plan) return { success: false, message: 'Formule inconnue' };
    if (!plan.actif) return { success: false, message: 'Cette formule n’est plus proposée' };

    if (plan.prix === null || plan.prix === undefined) {
      // Formule « sur devis » : rien à facturer tant qu'aucun montant n'a été
      // négocié. La refuser ici évite un paiement de 0 €.
      return {
        success: false,
        message: 'Cette formule est proposée sur devis. Contactez-nous pour obtenir une proposition.',
        code: 'SUBSCRIPTION_QUOTE_REQUIRED',
      };
    }

    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const stripe = requireStripe();

    // Client Stripe réutilisé d'une souscription à l'autre : en recréer un
    // dupliquerait le contact et disperserait l'historique de facturation.
    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: org.email || undefined,
        name: org.nom,
        metadata: { organisationId: org.id },
      });
      customerId = customer.id;
      await org.update({ stripe_customer_id: customerId });
    }

    const prix = Number(plan.prix);
    const montant = Math.round(prix * 100); // Stripe facture en centimes

    const paymentIntent = await stripe.paymentIntents.create({
      amount: montant,
      currency: (plan.devise || 'EUR').toLowerCase(),
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      // Ces métadonnées sont ce que le webhook relira : sans elles, un
      // paiement confirmé n'aurait plus de destinataire.
      metadata: {
        organisationId: org.id,
        planId: plan.id,
        planCode: plan.code,
      },
    });

    // Souscription EN ATTENTE : trace du parcours engagé, sans aucun droit.
    await AbonnementSouscrit.create({
      organisationId: org.id,
      planAbonnementId: plan.id,
      plan_code: plan.code,
      plan_nom: plan.nom,
      // Prix figé ICI : un changement de tarif ultérieur ne réécrira pas ce
      // qui a été proposé au client.
      prix_paye: prix,
      devise: plan.devise,
      periode: plan.periode,
      statut: 'en_attente',
      fournisseur: 'stripe',
      reference_paiement: paymentIntent.id,
      stripe_customer_id: customerId,
    });

    return {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      montant,
      devise: plan.devise,
      plan: vuePublique(plan),
    };
  }

  /**
   * Changement de formule.
   *
   * Passe par le même parcours de paiement : c'est le webhook qui bascule
   * l'organisation sur la nouvelle formule. Rien n'est accordé d'avance.
   */
  static async changerPlan(organisationId, planId) {
    return SubscriptionService.creerPaymentIntent(organisationId, planId);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  WEBHOOK
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Traite un événement Stripe.
   *
   * Deux verrous, dans cet ordre :
   *   1. la SIGNATURE — sans elle, n'importe qui pourrait s'offrir un
   *      abonnement en postant un faux « paiement réussi » ;
   *   2. l'IDEMPOTENCE — Stripe réémet tant qu'il n'a pas reçu de 2xx. Le
   *      même événement arrive donc plusieurs fois, et sans journal chaque
   *      réception rejouait l'activation.
   */
  static async handleWebhook(payload, signature) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!endpointSecret) {
      logger.error('[stripe] STRIPE_WEBHOOK_SECRET non configuré');
      return { success: false, message: 'Webhook non configuré' };
    }

    const stripe = getStripe();
    if (!stripe) {
      logger.error('[stripe] Webhook reçu mais STRIPE_SECRET_KEY non configurée');
      return { success: false, message: 'Stripe non configuré' };
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, endpointSecret);
    } catch (err) {
      logger.warn(`[stripe] Signature webhook invalide : ${err.message}`);
      return { success: false, message: 'Signature invalide', statusCode: 400 };
    }

    return SubscriptionService.traiterEvenement('stripe', event.id, event.type, event.data.object);
  }

  /**
   * Cœur du traitement, commun à Stripe et à PayTech.
   *
   * L'enregistrement du journal se fait AVANT le traitement : si celui-ci
   * échoue à mi-chemin, la ligne existe avec `traite_le` nul, ce qui distingue
   * « jamais vu » de « vu mais non abouti ».
   */
  static async traiterEvenement(fournisseur, evenementId, type, objet) {
    let journal;
    try {
      journal = await EvenementPaiement.create({
        fournisseur,
        evenement_id: evenementId,
        type,
        organisationId: objet?.metadata?.organisationId || null,
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Déjà reçu : on répond 2xx pour que le fournisseur cesse de réémettre.
        logger.info(`[${fournisseur}] Événement déjà traité, ignoré : ${evenementId}`);
        return { success: true, received: true, duplicate: true };
      }
      throw err;
    }

    try {
      await SubscriptionService._appliquerEvenement(type, objet);
      await journal.update({ traite_le: new Date() });
      return { success: true, received: true };
    } catch (err) {
      // La trace reste, sans `traite_le` : l'événement pourra être rejoué
      // manuellement après correction.
      await journal.update({ erreur: err.message });
      logger.error(`[${fournisseur}] Traitement de ${evenementId} échoué : ${err.message}`);
      throw err;
    }
  }

  /** Aiguillage par type d'événement. */
  static async _appliquerEvenement(type, objet) {
    switch (type) {
      case 'payment_intent.succeeded':
        await SubscriptionService._activerDepuisPaiement(objet.id, objet.customer);
        break;

      case 'payment_intent.payment_failed':
        await SubscriptionService._marquerEchec(objet.id);
        break;

      case 'invoice.paid':
      case 'customer.subscription.updated':
        // Renouvellement d'un abonnement récurrent. Rattaché par le CLIENT
        // Stripe : contrairement au PaymentIntent, une facture ne porte pas
        // les métadonnées posées à la création — s'y fier laissait cette
        // branche sans effet.
        await SubscriptionService._prolongerParClient(objet.customer, objet.subscription || null);
        break;

      case 'customer.subscription.deleted':
        await SubscriptionService._resilierParClient(objet.customer);
        break;

      // PayTech (Mobile Money) — même chemin que Stripe : prix relu en base,
      // souscription historisée, idempotence assurée par `traiterEvenement`.
      case 'sale_complete':
        await SubscriptionService.enregistrerPaiementExterne(objet);
        break;

      default:
        logger.info(`[paiement] Événement non géré : ${type}`);
    }
  }

  /**
   * Active la souscription attachée à un paiement confirmé.
   *
   * On repart de la RÉFÉRENCE du paiement, pas des métadonnées : c'est elle
   * qui identifie sans ambiguïté la souscription créée en attente, et son prix
   * proposé.
   */
  static async _activerDepuisPaiement(referencePaiement, stripeCustomerId) {
    const souscription = await AbonnementSouscrit.findOne({
      where: { reference_paiement: referencePaiement },
    });

    if (!souscription) {
      logger.warn(`[paiement] Aucune souscription pour la référence ${referencePaiement}`);
      return;
    }
    if (souscription.statut === 'active') return; // déjà activée

    const debut = new Date();
    await souscription.update({
      statut: 'active',
      date_debut: debut,
      date_fin: calculerDateFin(debut, souscription.periode),
      stripe_customer_id: stripeCustomerId || souscription.stripe_customer_id,
    });

    // Les souscriptions PRÉCÉDENTES cessent : sans cela, un changement de
    // formule laisserait deux lignes actives et `souscriptionActive` en
    // choisirait une au hasard.
    await AbonnementSouscrit.update(
      { statut: 'expiree' },
      {
        where: {
          organisationId: souscription.organisationId,
          statut: 'active',
          id: { [require('sequelize').Op.ne]: souscription.id },
        },
      }
    );

    await SubscriptionService._synchroniserOrganisation(souscription);
    logger.info(`[paiement] Abonnement ${souscription.plan_code} activé pour ${souscription.organisationId}`);
  }

  static async _marquerEchec(referencePaiement) {
    const souscription = await AbonnementSouscrit.findOne({
      where: { reference_paiement: referencePaiement },
    });
    // On ne touche PAS à une souscription déjà active : un échec de
    // renouvellement ne doit pas effacer le mois déjà payé.
    if (souscription && souscription.statut === 'en_attente') {
      await souscription.update({ statut: 'echec' });
    }
  }

  /** Prolonge la souscription active d'un client Stripe (renouvellement). */
  static async _prolongerParClient(stripeCustomerId, stripeSubscriptionId) {
    if (!stripeCustomerId) return;

    const org = await Organisation.findOne({ where: { stripe_customer_id: stripeCustomerId } });
    if (!org) {
      logger.warn(`[paiement] Aucune organisation pour le client Stripe ${stripeCustomerId}`);
      return;
    }

    const souscription = await DroitsService.souscriptionActive(org.id);
    if (!souscription) return;

    const debut = souscription.date_fin && new Date(souscription.date_fin) > new Date()
      ? new Date(souscription.date_fin)
      : new Date();

    await souscription.update({
      date_fin: calculerDateFin(debut, souscription.periode),
      // Le VRAI identifiant d'abonnement Stripe. L'ancien code écrivait ici
      // l'identifiant CLIENT, rendant tout rapprochement impossible.
      stripe_subscription_id: stripeSubscriptionId || souscription.stripe_subscription_id,
    });
  }

  static async _resilierParClient(stripeCustomerId) {
    if (!stripeCustomerId) return;
    const org = await Organisation.findOne({ where: { stripe_customer_id: stripeCustomerId } });
    if (!org) return;

    await AbonnementSouscrit.update(
      { statut: 'annulee' },
      { where: { organisationId: org.id, statut: 'active' } }
    );
    await org.update({ is_subscribed: false });
  }

  /**
   * Encaissement confirmé par un fournisseur EXTERNE (PayTech aujourd'hui).
   *
   * Remplace l'ancien `_activerAbonnement`, qui écrivait directement sur
   * l'organisation sans historique, sans prix et sans idempotence — et qui
   * plaçait au passage l'identifiant CLIENT dans la colonne de l'abonnement.
   *
   * Le prix est relu EN BASE, jamais pris dans la notification : un montant
   * transmis par le fournisseur reste une donnée entrante, qu'on ne facture
   * pas sur parole. Le montant réellement encaissé est conservé à part
   * (`note`) quand il diffère, pour que l'écart soit visible au lieu d'être
   * silencieusement écrasé.
   *
   * @param {object} p
   * @param {string} p.organisationId
   * @param {string} p.planId        identifiant OU code de la formule
   * @param {string} p.reference     référence du paiement chez le fournisseur
   * @param {string} [p.fournisseur] 'paytech' par défaut
   * @param {number} [p.montantRecu] montant annoncé par le fournisseur
   */
  static async enregistrerPaiementExterne({
    organisationId, planId, reference, fournisseur = 'paytech', montantRecu,
  }) {
    if (!organisationId) {
      logger.warn('[paiement] Encaissement externe sans organisation — ignoré');
      return;
    }

    const org = await Organisation.findByPk(organisationId);
    if (!org) {
      logger.warn(`[paiement] Organisation introuvable : ${organisationId}`);
      return;
    }

    const plan = planId
      ? await PlanAbonnement.findOne({
        where: /^[0-9a-f-]{36}$/i.test(String(planId)) ? { id: planId } : { code: planId },
      })
      : null;

    if (!plan) {
      logger.warn(`[paiement] Formule introuvable pour l'encaissement ${reference} : ${planId}`);
      return;
    }

    // Rejeu : la référence est unique en base, on ne recrée pas.
    if (reference) {
      const dejaLa = await AbonnementSouscrit.findOne({ where: { reference_paiement: reference } });
      if (dejaLa) return;
    }

    const debut = new Date();
    const prixCatalogue = plan.prix === null ? null : Number(plan.prix);
    const ecart = montantRecu !== undefined && montantRecu !== null
      && prixCatalogue !== null && Number(montantRecu) !== prixCatalogue;

    await AbonnementSouscrit.update(
      { statut: 'expiree' },
      { where: { organisationId, statut: 'active' } }
    );

    const souscription = await AbonnementSouscrit.create({
      organisationId,
      planAbonnementId: plan.id,
      plan_code: plan.code,
      plan_nom: plan.nom,
      prix_paye: prixCatalogue,
      devise: plan.devise,
      periode: plan.periode,
      statut: 'active',
      date_debut: debut,
      date_fin: calculerDateFin(debut, plan.periode),
      fournisseur,
      reference_paiement: reference || null,
      note: ecart
        ? `Montant annoncé par ${fournisseur} : ${montantRecu} — différent du tarif catalogue (${prixCatalogue}).`
        : null,
    });

    await SubscriptionService._synchroniserOrganisation(souscription);
    logger.info(`[paiement] Abonnement ${plan.code} activé pour ${organisationId} via ${fournisseur}`);
  }

  /**
   * Recopie l'état courant sur l'organisation.
   *
   * `abonnement` et `is_subscribed` restent la vue « à plat » lue par
   * `checkSubscription` et affichée dans le mobile. La VÉRITÉ est dans
   * `abonnements_souscrits` ; ces colonnes n'en sont qu'un reflet, conservé
   * pour ne rien casser de l'existant.
   */
  static async _synchroniserOrganisation(souscription) {
    const org = await Organisation.findByPk(souscription.organisationId);
    if (!org) return;

    await org.update({
      is_subscribed: souscription.statut === 'active',
      abonnement: souscription.plan_nom,
      stripe_customer_id: souscription.stripe_customer_id || org.stripe_customer_id,
      stripe_subscription_id: souscription.stripe_subscription_id || org.stripe_subscription_id,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ANNULATION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Annule l'abonnement.
   *
   * La souscription reste consultable dans l'historique — on ne réécrit pas le
   * passé. Contrairement à l'ancienne version, on ne rétro-date PAS la fin
   * d'essai : cela mélangeait deux notions et privait le client de la période
   * qu'il avait payée.
   */
  static async annulerAbonnement(organisationId) {
    const souscription = await DroitsService.souscriptionActive(organisationId);
    if (!souscription) {
      return { success: false, message: 'Aucun abonnement actif à annuler' };
    }

    await souscription.update({ statut: 'annulee' });

    const org = await Organisation.findByPk(organisationId);
    if (org) await org.update({ is_subscribed: false });

    return { success: true, message: 'Abonnement annulé' };
  }

  /**
   * Activation MANUELLE par un administrateur — le cas « sur devis ».
   *
   * Réservée au super-admin par la route qui l'expose. Le prix négocié est
   * enregistré tel quel dans l'historique : c'est lui qui fait foi, pas le
   * catalogue.
   */
  static async activerManuellement(organisationId, { planId, prix, periode, dateFin, note }, adminId) {
    const plan = await PlanAbonnement.findOne({
      where: /^[0-9a-f-]{36}$/i.test(String(planId)) ? { id: planId } : { code: planId },
    });
    if (!plan) return { success: false, message: 'Formule inconnue' };

    const org = await Organisation.findByPk(organisationId);
    if (!org) return { success: false, message: 'Organisation introuvable' };

    const debut = new Date();
    const periodeRetenue = periode || plan.periode;

    // Les souscriptions actives précédentes cessent — même règle que pour un
    // paiement, sinon deux lignes resteraient actives en parallèle.
    await AbonnementSouscrit.update(
      { statut: 'expiree' },
      { where: { organisationId, statut: 'active' } }
    );

    const souscription = await AbonnementSouscrit.create({
      organisationId,
      planAbonnementId: plan.id,
      plan_code: plan.code,
      plan_nom: plan.nom,
      prix_paye: prix === undefined || prix === null ? plan.prix : prix,
      devise: plan.devise,
      periode: periodeRetenue,
      statut: 'active',
      date_debut: debut,
      date_fin: dateFin ? new Date(dateFin) : calculerDateFin(debut, periodeRetenue),
      fournisseur: 'manuel',
      activee_par: adminId || null,
      note: note || null,
    });

    await SubscriptionService._synchroniserOrganisation(souscription);
    logger.info(`[abonnement] Activation manuelle ${plan.code} pour ${organisationId} par ${adminId}`);

    return { success: true, message: 'Abonnement activé', souscription };
  }
}

module.exports = SubscriptionService;
module.exports.vuePublique = vuePublique;
module.exports.calculerDateFin = calculerDateFin;
