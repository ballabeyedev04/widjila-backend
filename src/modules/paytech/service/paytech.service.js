'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { Organisation } = require('../../../models/index.js');
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
   * Vérifie une notification IPN (les deux méthodes)
   */
  verifyIpn(payload) {
    const { item_price, ref_command, api_key_sha256, api_secret_sha256, hmac_compute } = payload;

    // Méthode 1: HMAC (recommandée)
    if (hmac_compute) {
      return this.verifyHmac(item_price, ref_command, hmac_compute);
    }

    // Méthode 2: SHA256 des clés
    if (api_key_sha256 && api_secret_sha256) {
      return this.verifySha256(api_key_sha256, api_secret_sha256);
    }

    return false;
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

      logger.info(`[paytech] Paiement initié: ${refCommand} -> token: ${token}`);
      return { success: true, token, redirectUrl: redirect_url };
    } catch (err) {
      logger.error(`[paytech] Erreur requestPayment: ${err.message}`);
      if (err.response?.data) {
        logger.error(`[paytech] Réponse erreur:`, err.response.data);
      }
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
    const { type_event, ref_command, item_price, token, payment_method, custom_field, item_name } = payload;

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

    // Extraire organisationId et planId du custom_field ou ref_command
    let organisationId, planId, priceId;

    try {
      if (custom_field) {
        const decoded = JSON.parse(Buffer.from(custom_field, 'base64').toString());
        organisationId = decoded.organisationId;
        planId = decoded.planId;
        priceId = decoded.priceId;
      }

      // Fallback: parser ref_command si format connu (ex: "org_123_plan_pro")
      if (!organisationId && ref_command) {
        const parts = ref_command.split('_');
        if (parts.length >= 3 && parts[0] === 'org') {
          organisationId = parts[1];
          planId = parts[2];
        }
      }
    } catch (e) {
      logger.warn('[paytech] Impossible de parser custom_field:', e.message);
    }

    if (!organisationId) {
      logger.error('[paytech] organisationId introuvable dans IPN');
      return { success: false, message: 'organisationId manquant' };
    }

    // Activer l'abonnement via le service existant
    try {
      await SubscriptionService._activerAbonnement(organisationId, planId, priceId, token);
      logger.info(`[paytech] Abonnement activé pour org ${organisationId} via PayTech`);
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