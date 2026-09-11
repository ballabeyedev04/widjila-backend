'use strict';

/**
 * Module Rapports — cahier des charges « Rapports de réserves » (§ 12).
 *
 * ── Ce que cette migration installe ────────────────────────────────────────
 *
 * 1. `rapports` s'enrichit de ce qu'un rapport est vraiment : un nom, un
 *    MODÈLE, un ÉTAT (§ 19), une configuration (filtres, sections, formats),
 *    une version, et deux fichiers possibles — PDF et Excel.
 * 2. `rapport_filtres` (REPORT_FILTER), `rapport_destinataires`
 *    (REPORT_RECIPIENT) et `rapport_historiques` (REPORT_HISTORY) reprennent
 *    les tables demandées.
 * 3. `rapport_partages` porte les liens sécurisés du § 14 : jeton révocable,
 *    expiration facultative, accès journalisés.
 *
 * ── Ce qu'elle NE fait PAS ─────────────────────────────────────────────────
 *
 * Elle ne touche à aucun rapport existant, sinon pour le DÉCRIRE : les
 * rapports déjà produits deviennent des rapports « générés », dans leur
 * version 1, avec le modèle correspondant à leur ancien type. Leur fichier,
 * leur date et leur auteur restent exactement ce qu'ils étaient — ce sont des
 * pièces déjà envoyées à des entreprises, elles ne se réécrivent pas.
 *
 * ── Pourquoi `fichier_url` devient facultatif ──────────────────────────────
 *
 * Le § 3 fait commencer le parcours par une CONFIGURATION (« + Nouveau
 * rapport → filtres → sections → prévisualiser »), et le § 19 nomme cet état
 * BROUILLON. Un brouillon n'a, par construction, aucun fichier : garder la
 * colonne obligatoire aurait forcé à inventer une URL vide, donc à rendre
 * indiscernable un rapport non généré d'un rapport dont le fichier a disparu.
 */

/** UUID portable — `gen_random_uuid()` n'existe qu'à partir de PostgreSQL 13. */
const UUID_SQL = "uuid_in(md5(random()::text || clock_timestamp()::text)::cstring)";

/** Ancien type de rapport → modèle du cahier des charges (§ 5). */
const MODELE_PAR_TYPE = {
  reserves: 'GLOBAL',
  entreprise: 'ENTREPRISE',
  batiment: 'BATIMENT',
  qualite: 'GLOBAL',
  visite: 'GLOBAL',
  opr: 'OPR',
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      const table = await queryInterface.describeTable('rapports');
      const ajouter = async (nom, definition) => {
        if (table[nom]) return;
        await queryInterface.addColumn('rapports', nom, definition, { transaction: t });
      };

      // ── 1. REPORT (§ 12) ───────────────────────────────────────────────
      await ajouter('nom', { type: Sequelize.STRING(200), allowNull: true });
      await ajouter('modele', { type: Sequelize.STRING(30), allowNull: true });
      await ajouter('statut', {
        type: Sequelize.STRING(20), allowNull: false, defaultValue: 'genere',
      });
      await ajouter('fichier_xlsx_url', { type: Sequelize.TEXT, allowNull: true });
      await ajouter('formats', { type: Sequelize.JSON, allowNull: true });
      await ajouter('sections', { type: Sequelize.JSON, allowNull: true });
      await ajouter('filtres', { type: Sequelize.JSON, allowNull: true });
      await ajouter('version', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });
      // Chaînage des VERSIONS (§ 18) : une nouvelle version d'un rapport déjà
      // diffusé est une NOUVELLE ligne, qui pointe vers celle qu'elle
      // remplace. L'ancienne reste lisible, avec son fichier et son historique.
      await ajouter('rapport_parent_id', { type: Sequelize.UUID, allowNull: true });
      await ajouter('genere_le', { type: Sequelize.DATE, allowNull: true });
      await ajouter('taille_pdf', { type: Sequelize.INTEGER, allowNull: true });
      await ajouter('nb_reserves', { type: Sequelize.INTEGER, allowNull: true });
      await ajouter('erreur', { type: Sequelize.TEXT, allowNull: true });
      // Rapport produit POUR une entreprise (§ 15) — sert à ne proposer
      // l'envoi qu'au responsable de cette entreprise-là.
      await ajouter('partenaire_id', { type: Sequelize.UUID, allowNull: true });
      // Les rapports d'un même lot « par entreprise » partagent cet
      // identifiant : c'est ce qui permet de les afficher ensemble.
      await ajouter('lot_generation_id', { type: Sequelize.UUID, allowNull: true });

      await queryInterface.changeColumn('rapports', 'fichier_url', {
        type: Sequelize.TEXT, allowNull: true,
      }, { transaction: t });

      // Les rapports DÉJÀ produits sont des rapports générés, version 1.
      await queryInterface.sequelize.query(
        `UPDATE rapports
            SET statut = 'genere',
                version = 1,
                genere_le = COALESCE(genere_le, created_at),
                formats = COALESCE(formats, '["PDF"]'::json)
          WHERE statut IS NULL OR statut = 'genere'`,
        { transaction: t },
      );

      for (const [type, modele] of Object.entries(MODELE_PAR_TYPE)) {
        await queryInterface.sequelize.query(
          `UPDATE rapports SET modele = :modele WHERE modele IS NULL AND type = :type`,
          { replacements: { modele, type }, transaction: t },
        );
      }
      // Un type inconnu (rapport produit par une version ultérieure, ou
      // importé) devient un rapport global : le classer ailleurs serait
      // affirmer un périmètre que personne n'a choisi.
      await queryInterface.sequelize.query(
        `UPDATE rapports SET modele = 'GLOBAL' WHERE modele IS NULL`,
        { transaction: t },
      );

      await queryInterface.addIndex('rapports', ['statut'], {
        name: 'rapports_statut', transaction: t,
      });
      await queryInterface.addIndex('rapports', ['lot_generation_id'], {
        name: 'rapports_lot_generation_id', transaction: t,
      });

      // ── 2. REPORT_FILTER (§ 12) ────────────────────────────────────────
      //
      // Une LIGNE PAR VALEUR retenue, et non une ligne par rapport : les
      // filtres du § 4 sont des sélections multiples (« Toutes ou sélection »).
      // Une seule ligne à colonnes scalaires n'aurait pas pu porter deux
      // entreprises, et aurait obligé à choisir laquelle des deux écrire.
      await queryInterface.createTable('rapport_filtres', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        rapport_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'rapports', key: 'id' },
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        batiment_id: { type: Sequelize.UUID, allowNull: true },
        etage_id: { type: Sequelize.UUID, allowNull: true },
        zone_id: { type: Sequelize.UUID, allowNull: true },
        partenaire_id: { type: Sequelize.UUID, allowNull: true },
        corps_etat_id: { type: Sequelize.UUID, allowNull: true },
        statut: { type: Sequelize.STRING(20), allowNull: true },
        gravite: { type: Sequelize.STRING(20), allowNull: true },
        date_debut: { type: Sequelize.DATEONLY, allowNull: true },
        date_fin: { type: Sequelize.DATEONLY, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction: t });
      await queryInterface.addIndex('rapport_filtres', ['rapport_id'], {
        name: 'rapport_filtres_rapport_id', transaction: t,
      });

      // ── 3. REPORT_RECIPIENT (§ 12 et § 13) ─────────────────────────────
      await queryInterface.createTable('rapport_destinataires', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        rapport_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'rapports', key: 'id' },
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        utilisateur_id: { type: Sequelize.UUID, allowNull: true },
        partenaire_id: { type: Sequelize.UUID, allowNull: true },
        nom: { type: Sequelize.STRING(200), allowNull: true },
        email: { type: Sequelize.STRING(255), allowNull: false },
        // 'to' (destinataire) ou 'cc' (copie) — le § 13 distingue les deux.
        role: { type: Sequelize.STRING(4), allowNull: false, defaultValue: 'to' },
        // Le rapport est-il parti en PIÈCE JOINTE ou en LIEN sécurisé (§ 13) ?
        mode: { type: Sequelize.STRING(20), allowNull: true },
        envoye_le: { type: Sequelize.DATE, allowNull: true },
        statut_envoi: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'en_attente',
        },
        erreur: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction: t });
      await queryInterface.addIndex('rapport_destinataires', ['rapport_id'], {
        name: 'rapport_destinataires_rapport_id', transaction: t,
      });

      // ── 4. REPORT_HISTORY (§ 12 et § 18) ───────────────────────────────
      await queryInterface.createTable('rapport_historiques', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        rapport_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'rapports', key: 'id' },
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        action: { type: Sequelize.STRING(40), allowNull: false },
        acteur_id: { type: Sequelize.UUID, allowNull: true },
        // Qui, quoi, combien : destinataires d'un envoi, taille d'un fichier,
        // adresse d'une consultation par lien.
        metadata: { type: Sequelize.JSON, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction: t });
      await queryInterface.addIndex('rapport_historiques', ['rapport_id', 'created_at'], {
        name: 'rapport_historiques_rapport_id_created_at', transaction: t,
      });

      // L'historique des rapports DÉJÀ produits n'est pas inventé : on y
      // inscrit le seul fait que la base connaisse avec certitude — ils ont
      // été générés, à leur date, par leur auteur.
      await queryInterface.sequelize.query(
        `INSERT INTO rapport_historiques (id, rapport_id, action, acteur_id, metadata, created_at)
         SELECT ${UUID_SQL}, r.id, 'genere', r.genere_par,
                json_build_object('reprise_historique', true), r.created_at
           FROM rapports r
          WHERE r.deleted_at IS NULL AND r.fichier_url IS NOT NULL`,
        { transaction: t },
      );

      // ── 5. Liens de partage sécurisés (§ 14) ───────────────────────────
      //
      // Seule l'EMPREINTE du jeton est stockée. Une fuite de la base ne doit
      // pas rendre les liens déjà distribués utilisables : le jeton en clair
      // n'existe qu'une fois, dans la réponse à la demande de partage.
      await queryInterface.createTable('rapport_partages', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        rapport_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'rapports', key: 'id' },
          onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        token_hash: { type: Sequelize.STRING(64), allowNull: false },
        cree_par: { type: Sequelize.UUID, allowNull: true },
        expire_le: { type: Sequelize.DATE, allowNull: true },
        revoque_le: { type: Sequelize.DATE, allowNull: true },
        // « éventuellement protégé par authentification » (§ 14)
        authentification_requise: {
          type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
        },
        nb_acces: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        dernier_acces_le: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction: t });
      await queryInterface.addIndex('rapport_partages', ['token_hash'], {
        name: 'rapport_partages_token_hash_unique', unique: true, transaction: t,
      });
      await queryInterface.addIndex('rapport_partages', ['rapport_id'], {
        name: 'rapport_partages_rapport_id', transaction: t,
      });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('rapport_partages', { transaction: t });
      await queryInterface.dropTable('rapport_historiques', { transaction: t });
      await queryInterface.dropTable('rapport_destinataires', { transaction: t });
      await queryInterface.dropTable('rapport_filtres', { transaction: t });

      await queryInterface.removeIndex('rapports', 'rapports_statut', { transaction: t });
      await queryInterface.removeIndex('rapports', 'rapports_lot_generation_id', { transaction: t });

      for (const colonne of [
        'nom', 'modele', 'statut', 'fichier_xlsx_url', 'formats', 'sections', 'filtres',
        'version', 'rapport_parent_id', 'genere_le', 'taille_pdf', 'nb_reserves', 'erreur',
        'partenaire_id', 'lot_generation_id',
      ]) {
        await queryInterface.removeColumn('rapports', colonne, { transaction: t });
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },
};
