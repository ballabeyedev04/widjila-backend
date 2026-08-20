'use strict';

/**
 * Migration : validation des inscriptions par le super-admin.
 *
 * L'inscription publique ne donne plus un compte immédiatement utilisable :
 * elle dépose une DEMANDE (statut 'en_attente_validation') que le super-admin
 * valide ou rejette depuis l'écran « Demandes d'inscription ».
 *
 * Trois colonnes suffisent à tracer la décision :
 *   - motif_rejet : obligatoire au rejet, repris tel quel dans l'email envoyé
 *     au demandeur — c'est la seule explication qu'il recevra ;
 *   - valide_par / valide_le : qui a tranché et quand. Le journal d'audit
 *     enregistre déjà l'action, mais il est purgeable et volumineux : garder
 *     la décision SUR le compte évite une jointure sur la table la plus
 *     lourde de la plateforme pour afficher « validé par X le Y ».
 *
 * La valeur 'rejete' est ajoutée à l'ENUM statut plutôt que de réutiliser
 * 'inactif' : un compte rejeté n'est pas un compte désactivé, et les deux
 * doivent rester distinguables dans la liste des demandes.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // PostgreSQL : ALTER TYPE pour étendre l'ENUM existant.
    await queryInterface.sequelize.query(
      "ALTER TYPE \"enum_utilisateur_statut\" ADD VALUE IF NOT EXISTS 'rejete';"
    );

    const table = await queryInterface.describeTable('utilisateur');

    if (!table.motif_rejet) {
      await queryInterface.addColumn('utilisateur', 'motif_rejet', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }

    if (!table.valide_par) {
      await queryInterface.addColumn('utilisateur', 'valide_par', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }

    if (!table.valide_le) {
      await queryInterface.addColumn('utilisateur', 'valide_le', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    // Les comptes existants ont été créés AVANT l'instauration du contrôle :
    // ils restent tels quels. Seul 'en_attente_validation' devient bloquant,
    // et ce statut n'était jusqu'ici posé que par la création de compte par un
    // admin — voir la note dans gestionUtilisateur.service.js, qui bascule ces
    // créations sur 'actif'. On débloque donc l'existant pour ne pas enfermer
    // dehors des comptes légitimes du jour au lendemain.
    await queryInterface.sequelize.query(
      "UPDATE utilisateur SET statut = 'actif' WHERE statut = 'en_attente_validation';"
    );

    // La liste des demandes filtre sur le statut et trie par date de création.
    await queryInterface.addIndex('utilisateur', ['statut', 'created_at'], {
      name: 'utilisateur_statut_created_at_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('utilisateur', 'utilisateur_statut_created_at_idx');
    await queryInterface.removeColumn('utilisateur', 'valide_le');
    await queryInterface.removeColumn('utilisateur', 'valide_par');
    await queryInterface.removeColumn('utilisateur', 'motif_rejet');
    // PostgreSQL ne permet pas de retirer une valeur d'un ENUM sans recréer le
    // type : 'rejete' subsiste après rollback (même parti pris que
    // 20260811000001-add-maitre-roles.js).
    console.warn("Rollback partiel : la valeur ENUM 'rejete' subsiste.");
  },
};
