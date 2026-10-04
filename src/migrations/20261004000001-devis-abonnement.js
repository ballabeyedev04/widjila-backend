'use strict';

/**
 * Migration : le parcours « Premium sur devis ».
 *
 *  1. table `devis` — la pièce qui manquait entre la demande du client et
 *     l'encaissement : montant négocié, durée, limites contractuelles,
 *     conditions, et le cycle brouillon → envoyé → accepté/refusé/expiré ;
 *
 *  2. quatre colonnes sur `abonnements_souscrits`, pour qu'un abonnement né
 *     d'un devis porte SES conditions et non celles du catalogue :
 *       - `devis_id`             : le devis dont il découle ;
 *       - `duree_mois`           : 18 ou 36 mois ne tiennent ni dans « mois »
 *                                  ni dans « an » ;
 *       - `limite_utilisateurs`  : la limite NÉGOCIÉE, qui prime sur celle de
 *       - `limite_chantiers`       la formule (voir `DroitsService.getDroits`).
 *
 * Les quatre sont nullables : une souscription achetée au catalogue n'en a
 * pas besoin et continue de lire les limites de son plan.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('devis', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      organisation_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'organisations', key: 'id' },
        onDelete: 'CASCADE',
      },
      numero: { type: Sequelize.STRING(30), allowNull: false, unique: true },
      statut: {
        type: Sequelize.ENUM('brouillon', 'envoye', 'accepte', 'refuse', 'expire'),
        allowNull: false,
        defaultValue: 'brouillon',
      },
      plan_abonnement_id: { type: Sequelize.UUID, allowNull: true },
      plan_code: { type: Sequelize.STRING(50), allowNull: true },
      plan_nom: { type: Sequelize.STRING(100), allowNull: true },
      montant_ht: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      taux_tva: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      montant_tva: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      montant_ttc: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      devise: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
      duree_mois: { type: Sequelize.INTEGER, allowNull: true },
      limite_utilisateurs: { type: Sequelize.INTEGER, allowNull: true },
      limite_chantiers: { type: Sequelize.INTEGER, allowNull: true },
      options: { type: Sequelize.JSONB, allowNull: true },
      conditions: { type: Sequelize.TEXT, allowNull: true },
      demande: { type: Sequelize.JSONB, allowNull: true },
      demande_par: { type: Sequelize.UUID, allowNull: true },
      prepare_par: { type: Sequelize.UUID, allowNull: true },
      envoye_le: { type: Sequelize.DATE, allowNull: true },
      accepte_le: { type: Sequelize.DATE, allowNull: true },
      refuse_le: { type: Sequelize.DATE, allowNull: true },
      expire_le: { type: Sequelize.DATE, allowNull: true },
      paye_le: { type: Sequelize.DATE, allowNull: true },
      motif_refus: { type: Sequelize.TEXT, allowNull: true },
      souscription_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('devis', ['organisation_id'], { name: 'devis_organisation_id' });
    await queryInterface.addIndex('devis', ['statut'], { name: 'devis_statut' });
    await queryInterface.addIndex('devis', ['organisation_id', 'statut'], { name: 'devis_organisation_statut' });

    const colonnes = await queryInterface.describeTable('abonnements_souscrits');
    const ajouts = {
      devis_id: { type: Sequelize.UUID, allowNull: true },
      duree_mois: { type: Sequelize.INTEGER, allowNull: true },
      limite_utilisateurs: { type: Sequelize.INTEGER, allowNull: true },
      limite_chantiers: { type: Sequelize.INTEGER, allowNull: true },
    };
    for (const [nom, definition] of Object.entries(ajouts)) {
      // Idempotent : la migration doit pouvoir être rejouée après un
      // déploiement interrompu sans échouer sur « column already exists ».
      if (!colonnes[nom]) await queryInterface.addColumn('abonnements_souscrits', nom, definition);
    }
  },

  async down(queryInterface) {
    for (const nom of ['devis_id', 'duree_mois', 'limite_utilisateurs', 'limite_chantiers']) {
      await queryInterface.removeColumn('abonnements_souscrits', nom).catch(() => {});
    }
    await queryInterface.dropTable('devis');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_devis_statut"');
  },
};
