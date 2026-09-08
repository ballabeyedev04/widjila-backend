'use strict';

/**
 * Archivage du reçu de paiement.
 *
 * Après chaque règlement, un justificatif PDF est généré, déposé sur le
 * stockage (Cloudflare R2 en production) et envoyé au payeur. On conserve son
 * URL pour deux raisons :
 *
 *   1. l'historique des paiements peut le reproposer des mois plus tard, sans
 *      le régénérer — donc sans risque qu'il diffère du document déjà remis ;
 *   2. un renvoi de courriel joint EXACTEMENT la pièce d'origine.
 *
 * Nullable : toutes les souscriptions antérieures n'en ont pas, et une panne
 * de génération ne doit pas empêcher d'activer un abonnement déjà payé.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('abonnements_souscrits');
    if (table.recu_url) return;

    await queryInterface.addColumn('abonnements_souscrits', 'recu_url', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('abonnements_souscrits');
    if (!table.recu_url) return;
    await queryInterface.removeColumn('abonnements_souscrits', 'recu_url');
  },
};
