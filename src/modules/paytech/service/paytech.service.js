'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { PlanAbonnement } = require('../../../models/index.js');
const logger = require('../../../utils/logger.js');
const SubscriptionService = require('../../subscription/service/subscription.service.js');

/**
 * Comparaison à temps constant tolérante aux entrées invalides.
 *
 * CAUSE DU BUG CORRIGÉ : `crypto.timingSafeEqual` LÈVE une `RangeError` quand
 * les deux buffers n'ont pas la même longueur, et `Buffer.from(undefined)` lève
 * une `TypeError`. Comme `POST /paytech/ipn` est une route publique (aucune
 * authentification), n'importe qui pouvait envoyer un `hmac_compute` absent,
 * numérique ou de longueur différente et déclencher une exception non gérée →
 * 500 systématique au lieu d'un simple rejet de signature.
 *
 * On valide donc le TYPE puis la LONGUEUR *avant* d'appeler `timingSafeEqual`.
 * Le cas nominal (deux chaînes hex de même longueur) reste comparé à temps
 * constant ; les cas invalides renvoient `false` sans lever.
 */
function safeCompare(attendu, recu) {
  if (typeof attendu !== 'string' || typeof recu !== 'string') return false;
  if (attendu.length === 0 || recu.length === 0) return false;

  const bufAttendu = Buffer.from(attendu, 'utf8');
  const bufRecu = Buffer.from(recu, 'utf8');

  // Longueurs différentes → signature forcément fausse. On sort AVANT
  // timingSafeEqual (qui lèverait). Aucune fuite d'information : la longueur
  // du HMAC attendu est publique (64 caractères hex pour SHA-256).
  if (bufAttendu.length !== bufRecu.length) return false;

  try {
    return crypto.timingSafeEqual(bufAttendu, bufRecu);
  } catch {
    return false;
  }
}

class PayTechService {
  constructor() {
    this.apiKey = process.env.PAYTECH_API_KEY;
    this.apiSecret = process.env.PAYTECH_API_SECRET;
    this.baseUrl = process.env.PAYTECH_BASE_URL || 'https://paytech.sn/api';
    this.env = process.env.PAYTECH_ENV || 'test';
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (!this.apiKey || !this.apiSecret) {
      logger.warn('[paytech] Clés API non configurées (PAYTECH_API_KEY, PAYTECH_API_SECRET)');
    }
  }

  /**
   * Vérifie si PayTech est configuré
   */
  isConfigured() {
    return !!(this.apiKey && this.apiSecret);
  }

  /**
   * Calcule le HMAC-SHA256 pour la vérification IPN
   * Format: HMAC(message = "${item_price}|${ref_command}|${api_key}", secret = api_secret)
   */
  computeHmac(itemPrice, refCommand) {
    const message = `${itemPrice}|${refCommand}|${this.apiKey}`;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  /**
   * Vérifie la signature HMAC d'une notification IPN
   */
  verifyHmac(itemPrice, refCommand, receivedHmac) {
    // Sans clés configurées, `createHmac(algo, undefined)` lève → on refuse
    // proprement plutôt que de laisser remonter une exception sur une route
    // publique.
    if (!this.isConfigured()) return false;
    const expected = this.computeHmac(itemPrice, refCommand);
    return safeCompare(expected, receivedHmac);
  }

  /**
   * Vérifie les hash SHA256 des clés (méthode alternative)
   */
  verifySha256(receivedApiKeySha256, receivedApiSecretSha256) {
    // Idem : `createHash().update(undefined)` lève une TypeError.
    if (!this.isConfigured()) return false;
    const expectedApiKeySha256 = crypto.createHash('sha256').update(this.apiKey).digest('hex');
    const expectedApiSecretSha256 = crypto.createHash('sha256').update(this.apiSecret).digest('hex');
    // `&&` non court-circuité volontairement : les deux comparaisons sont
    // évaluées pour ne pas révéler laquelle a échoué via le temps de réponse.
    const okKey = safeCompare(expectedApiKeySha256, receivedApiKeySha256);
    const okSecret = safeCompare(expectedApiSecretSha256, receivedApiSecretSha256);
    return okKey && okSecret;
  }

  /**
   * Vérifie une notification IPN — méthode HMAC UNIQUEMENT.
   *
   * La méthode « SHA256 des clés » (`verifySha256`) n'est plus acceptée : elle
   * compare deux empreintes STATIQUES, identiques pour toutes les
   * notifications. Une seule notification capturée devenait un sésame
   * permanent, rejouable avec n'importe quel contenu. Le HMAC, lui, porte sur
   * `item_price|ref_command` : il lie la signature au montant et à la commande.
   */
  verifyIpn(payload) {
    const { item_price, ref_command, hmac_compute } = payload || {};
    if (!hmac_compute) return false;
    return this.verifyHmac(item_price, ref_command, hmac_compute);
  }

  /**
   * Montant attendu en XOF pour une formule, tel qu'il est demandé à PayTech.
   * Le franc CFA a une parité FIXE avec l'euro (1 EUR = 655,957 XOF).
   * @returns {number|null} null si la formule n'a pas de prix exploitable.
   */
  montantXof(plan) {
    if (!plan || plan.prix === null || plan.prix === undefined) return null;
    const prix = Number(plan.prix);
    if (!Number.isFinite(prix) || prix <= 0) return null;
    const devise = String(plan.devise || 'EUR').toUpperCase();
    if (devise === 'XOF') return Math.round(prix);
    if (devise === 'EUR') return Math.round(prix * 655.957);
    return null; // aucune conversion fiable : on ne devine pas
  }

  /**
   * Organisation et formule tirées de `ref_command` — la SEULE donnée
   * d'identification couverte par le HMAC (`custom_field` ne l'est pas).
   * Format produit par `generateRefCommand` : org_<uuid>_<code>_<ts>_<alea>.
   * @returns {{ organisationId: string, planCode: string }|null}
   */
  lireRefCommand(refCommand) {
    const m = /^org_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([a-z0-9-]{1,50})_/i
      .exec(String(refCommand || ''));
    return m ? { organisationId: m[1], planCode: m[2] } : null;
  }

  /**
   * Initie un paiement PayTech
   * @param {Object} params - Paramètres du paiement
   * @param {string} params.itemName - Nom du produit/service
   * @param {number} params.itemPrice - Montant en XOF (entier)
   * @param {string} params.refCommand - Référence unique de la commande
   * @param {string} params.commandName - Description de la commande
   * @param {Object} options - Options supplémentaires
   * @param {string} options.currency - Devise (défaut: XOF)
   * @param {string} options.targetPayment - Méthode(s) de paiement (ex: "Orange Money, Wave, Free Money")
   * @param {string} options.customField - Données additionnelles (JSON string)
   * @param {string} options.successUrl - URL de redirection après succès
   * @param {string} options.cancelUrl - URL de redirection après annulation
   * @param {string} options.ipnUrl - URL de notification IPN (override)
   * @returns {Promise<Object>} Résultat avec token et redirect_url
   */
  async requestPayment(params, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('PayTech non configuré : clés API manquantes');
    }

    const {
      itemName,
      itemPrice,
      refCommand,
      commandName,
    } = params;

    const {
      currency = 'XOF',
      targetPayment = 'Orange Money, Wave, Free Money',
      customField = null,
      successUrl = `${this.frontendUrl}/abonnement?payment=success`,
      cancelUrl = `${this.frontendUrl}/abonnement?payment=cancel`,
      ipnUrl = `${process.env.API_PUBLIC_URL || 'https://api.votre-domaine.com'}/api/v1/paytech/ipn`,
    } = options;

    const payload = {
      item_name: itemName,
      item_price: itemPrice,
      ref_command: refCommand,
      command_name: commandName,
      currency,
      env: this.env,
      target_payment: targetPayment,
      success_url: successUrl,
      cancel_url: cancelUrl,
      ipn_url: ipnUrl,
    };

    if (customField) {
      payload.custom_field = typeof customField === 'string' ? customField : JSON.stringify(customField);
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/payment/request-payment`,
        payload,
        {
          headers: {
            'API_KEY': this.apiKey,
            'API_SECRET': this.apiSecret,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const { success, token, redirect_url, message } = response.data;

      if (!success || success !== 1) {
        throw new Error(message || 'Échec de la création du paiement PayTech');
      }

      // Le jeton de paiement ouvre la page de paiement et sert à en lire le
      // statut : il n'a rien à faire en clair dans un journal. Son début suffit
      // à recouper avec la console PayTech.
      logger.info(`[paytech] Paiement initié: ${refCommand} -> token: ${String(token || '').slice(0, 6)}…`);
      return { success: true, token, redirectUrl: redirect_url };
    } catch (err) {
      logger.error(`[paytech] Erreur requestPayment: ${err.message}`, {
        dependance: 'paytech',
        statutHttp: err.response?.status,
        code: err.code,
        reponse: err.response?.data,
      });
      throw new Error(`Erreur PayTech: ${err.response?.data?.message || err.message}`);
    }
  }

  /**
   * Vérifie le statut d'un paiement par token
   */
  async getPaymentStatus(token) {
    if (!this.isConfigured()) {
      throw new Error('PayTech non configuré');
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/payment/get-status`,
        {
          params: { token_payment: token },
          headers: {
            'API_KEY': this.apiKey,
            'API_SECRET': this.apiSecret,
          },
          timeout: 15000,
        }
      );

      return response.data;
    } catch (err) {
      logger.error(`[paytech] Erreur getPaymentStatus: ${err.message}`);
      throw new Error(`Erreur vérification statut: ${err.message}`);
    }
  }

  /**
   * Traite une notification IPN de paiement réussi
   */
  async handlePaymentIpn(payload) {
    const { type_event, ref_command, item_price, env } = payload || {};

    logger.info(`[paytech] IPN reçu: ${type_event} pour ${ref_command}`);

    // Vérification de sécurité
    if (!this.verifyIpn(payload)) {
      logger.warn(`[paytech] IPN signature invalide pour ${ref_command}`);
      return { success: false, message: 'Signature invalide' };
    }

    if (type_event !== 'sale_complete') {
      logger.info(`[paytech] Événement non traité: ${type_event}`);
      return { success: true, message: 'Événement ignoré' };
    }

    // En production, un encaissement de l'environnement de TEST n'ouvre rien :
    // un paiement fictif signé avec les mêmes clés activerait sinon une formule.
    if (process.env.NODE_ENV === 'production' && (this.env !== 'prod' || (env && env !== 'prod'))) {
      logger.error(`[paytech] IPN hors environnement de production refusé pour ${ref_command}`);
      return { success: false, message: 'Environnement PayTech invalide' };
    }

    // ── Organisation et formule : UNIQUEMENT depuis la donnée signée ────────
    //
    // Elles étaient lues dans `custom_field`, que le HMAC ne couvre pas : une
    // notification authentique, rejouée avec un `custom_field` réécrit,
    // activait n'importe quelle formule pour n'importe quelle organisation.
    // `ref_command` est signé et porte les deux.
    const cible = this.lireRefCommand(ref_command);
    if (!cible) {
      logger.error(`[paytech] ref_command illisible : ${ref_command}`);
      return { success: false, message: 'Référence de commande invalide' };
    }

    // ── Le montant signé doit être le tarif de la formule ──────────────────
    const plan = await PlanAbonnement.findOne({ where: { code: cible.planCode } });
    const attendu = this.montantXof(plan);
    if (!plan || !plan.actif || attendu === null) {
      logger.error(`[paytech] Formule non achetable pour ${ref_command} : ${cible.planCode}`);
      return { success: false, message: 'Formule invalide' };
    }
    if (Number(item_price) !== attendu) {
      logger.error(
        `[paytech] ÉCART DE MONTANT sur ${ref_command} : reçu ${item_price} XOF, `
        + `attendu ${attendu} XOF pour ${plan.code} — activation refusée`
      );
      return { success: false, message: 'Montant incorrect' };
    }

    // Même chemin que Stripe : prix relu EN BASE, souscription historisée, et
    // idempotence portée par `traiterEvenement`.
    //
    // L'identifiant d'événement est `ref_command` — signé, unique par
    // commande. Le `token` PayTech ne l'est PAS : s'en servir de clé
    // d'idempotence laissait rejouer la même notification sous un token neuf.
    try {
      const resultat = await SubscriptionService.traiterEvenement(
        'paytech',
        ref_command,
        'sale_complete',
        {
          organisationId: cible.organisationId,
          planId: plan.code,
          reference: ref_command,
          fournisseur: 'paytech',
        }
      );
      if (resultat.duplicate) {
        logger.info(`[paytech] IPN déjà traité pour ${ref_command}`);
      }
      return { success: true, message: 'Abonnement activé' };
    } catch (err) {
      logger.error(`[paytech] Erreur activation abonnement: ${err.message}`);
      return { success: false, message: 'Erreur activation' };
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CAUSE DU BUG CORRIGÉ : les trois méthodes ci-dessous étaient déclarées
  // `static`, alors que ce module exporte une INSTANCE (`module.exports = new
  // PayTechService()`). En JavaScript, une méthode `static` vit sur le
  // constructeur, jamais sur l'instance ni sur le prototype : côté appelant,
  // `PayTechService.generateRefCommand` valait donc `undefined` et
  // `paytech.controller.js` plantait en « is not a function » → 500 à chaque
  // `POST /paytech/create-payment`. Aucun paiement PayTech ne pouvait démarrer.
  //
  // Choix de correction : retirer `static` (méthodes d'instance) plutôt
  // qu'exporter la classe. Vérifié par recherche sur `src/` : les 10 usages de
  // `PayTechService.` sont tous des appels sur l'instance importée
  // (`isConfigured`, `requestPayment`, `getPaymentStatus`, `handlePaymentIpn`…),
  // et le constructeur initialise `this.apiKey`/`this.baseUrl`/`this.env` dont
  // ces méthodes-là dépendent. Exporter la classe aurait cassé les 7 autres
  // appels ; retirer `static` n'en casse aucun.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Génère une référence de commande unique
   */
  generateRefCommand(organisationId, planId) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `org_${organisationId}_${planId}_${timestamp}_${random}`.substring(0, 64);
  }

  /**
   * Encode custom_field en Base64 JSON
   */
  encodeCustomField(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }

  /**
   * Décode custom_field depuis Base64
   */
  decodeCustomField(encoded) {
    try {
      return JSON.parse(Buffer.from(encoded, 'base64').toString());
    } catch {
      return null;
    }
  }
}

module.exports = new PayTechService();