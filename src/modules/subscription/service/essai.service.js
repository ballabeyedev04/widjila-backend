'use strict';

const { Organisation } = require('../../../models/index.js');
const { finEssai } = require('../../../config/essai.js');
const logger = require('../../../utils/logger.js');

/**
 * Démarrage de l'essai gratuit.
 *
 * L'essai commence quand l'usage devient possible — c'est-à-dire quand le
 * super-admin valide l'inscription — et non à l'inscription elle-même. Le
 * raisonnement complet est dans config/essai.js.
 */
class EssaiService {

  /**
   * Démarre l'essai d'une organisation, si et seulement s'il n'a jamais
   * démarré.
   *
   * La condition est portée par le WHERE, pas par une lecture suivie d'une
   * écriture : deux validations simultanées (deux comptes d'une même
   * organisation validés coup sur coup) liraient toutes les deux NULL et
   * poseraient toutes les deux une nouvelle date. C'est la base qui arbitre,
   * et la seconde mise à jour ne touche alors aucune ligne.
   *
   * `trial_ends_at IS NULL` est donc la garantie « une seule fois » : sans
   * elle, chaque validation d'un membre supplémentaire rallongerait l'essai
   * de l'organisation — un moyen simple de ne jamais le voir expirer.
   *
   * `is_subscribed = false` exclut une organisation qui paie déjà : lui poser
   * une date d'essai ne lui retirerait rien aujourd'hui, mais ferait mentir
   * l'écran d'abonnement, qui affiche l'essai à côté de la formule.
   *
   * @param {string} organisationId
   * @param {{ transaction?: object }} [options]
   * @returns {Promise<boolean>} Vrai si l'essai vient d'être démarré.
   */
  static async demarrerEssai(organisationId, { transaction } = {}) {
    // Le super-admin plateforme n'appartient à aucune organisation : rien à
    // démarrer, et ce n'est pas une anomalie.
    if (!organisationId) return false;

    const [modifiees] = await Organisation.update(
      { trial_ends_at: finEssai() },
      {
        where: { id: organisationId, trial_ends_at: null, is_subscribed: false },
        transaction,
      }
    );

    if (modifiees > 0) {
      logger.info(`[essai] Essai gratuit démarré pour l'organisation ${organisationId}`);
    }
    return modifiees > 0;
  }
}

module.exports = EssaiService;
