'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Migration : table `corps_etat` — le catalogue des métiers / types de travaux
 * du BTP, et son remplissage standard.
 *
 * Voir `src/models/corpsEtat.model.js` pour le raisonnement (pourquoi une
 * table plutôt qu'un ENUM, et ce que signifie `organisation_id = NULL`).
 *
 * LES CODES DU CATALOGUE STANDARD REPRENNENT EXACTEMENT les dix valeurs de
 * l'ancien ENUM `reserves.categorie`. C'est ce qui permet à la migration
 * suivante de rattacher les réserves déjà en base sans interprétation, et à un
 * client mobile non mis à jour de continuer à envoyer `categorie`.
 */

/**
 * Catalogue standard, dans l'ORDRE D'UN CHANTIER — démolition, gros œuvre,
 * clos et couvert, second œuvre, finitions — et non dans l'ordre
 * alphabétique, qui placerait « Peinture » avant « Plomberie » et
 * « Démolitions » au milieu.
 *
 * Les codes marqués (ENUM) existaient déjà dans `reserves.categorie`.
 */
const CATALOGUE = [
  ['demolitions', 'Démolitions', 'Dépose et démolition des ouvrages existants.'],
  ['terrassement', 'Terrassement / VRD', 'Terrassement, voiries et réseaux divers.'],
  ['fondations', 'Fondations', 'Fondations superficielles et profondes.'],
  ['gros_oeuvre', 'Gros œuvre', 'Structure, planchers, murs porteurs.'],            // ENUM
  ['maconnerie', 'Maçonnerie', 'Ouvrages maçonnés, reprises et scellements.'],      // ENUM
  ['charpente', 'Charpente', 'Charpente bois, métallique ou béton.'],
  ['couverture', 'Couverture', 'Couverture, zinguerie et évacuation des eaux pluviales.'],
  ['etancheite', 'Étanchéité', 'Étanchéité des toitures-terrasses et parties enterrées.'], // ENUM
  ['ravalement', 'Ravalement', 'Ravalement et traitement des façades.'],
  ['isolation', 'Isolation', 'Isolation thermique et acoustique.'],                 // ENUM
  ['menuiseries_exterieures', 'Menuiseries extérieures', 'Fenêtres, portes extérieures, occultations.'],
  ['serrurerie', 'Serrurerie / Métallerie', 'Garde-corps, portails, ouvrages métalliques.'],
  ['electricite', 'Électricité courants forts et faibles', 'Distribution électrique, éclairage, courants faibles.'], // ENUM
  ['plomberie', 'Plomberie', 'Alimentation et évacuation, appareils sanitaires.'],  // ENUM
  ['cvc', 'CVC — Chauffage, ventilation, climatisation', 'Production, distribution et traitement d’air.'],
  ['cloisons_doublages', 'Cloisons & doublages', 'Cloisons, doublages et habillages.'],
  ['plafonds', 'Plafonds', 'Plafonds suspendus et faux plafonds.'],
  ['menuiserie', 'Menuiserie intérieure', 'Portes intérieures, placards, agencement.'], // ENUM
  ['carrelage', 'Carrelage & faïence', 'Revêtements de sols et murs scellés ou collés.'], // ENUM
  ['sols_souples', 'Revêtements de sols souples', 'Sols PVC, moquette, linoléum, parquets collés.'],
  ['peinture', 'Peinture', 'Préparation des supports, peinture et revêtements muraux.'], // ENUM
  ['ascenseurs', 'Ascenseurs', 'Appareils élévateurs et leur mise en service.'],
  ['amenagements_exterieurs', 'Aménagements extérieurs', 'Espaces verts, clôtures, mobilier extérieur.'],
  ['nettoyage', 'Nettoyage de livraison', 'Nettoyage avant réception et livraison.'],
  ['autre', 'Autre', 'Travaux ne relevant d’aucun autre corps d’état.'],            // ENUM
];

module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotence — même garde que les autres migrations du projet.
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('corps_etat');

    if (!existe) {
      await queryInterface.createTable('corps_etat', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
          allowNull: false,
        },
        // NULL = catalogue standard de la plateforme, partagé par toutes les
        // organisations. CASCADE : les métiers propres à une organisation
        // disparaissent avec elle.
        organisation_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'organisations', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        nom: {
          type: Sequelize.STRING(100),
          allowNull: false,
        },
        code: {
          type: Sequelize.STRING(50),
          allowNull: true,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        ordre: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        actif: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        deleted_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
      });

      await queryInterface.addIndex('corps_etat', ['organisation_id'], { name: 'corps_etat_organisation_id' });
      await queryInterface.addIndex('corps_etat', ['actif'], { name: 'corps_etat_actif' });
      await queryInterface.addIndex('corps_etat', ['code'], { name: 'corps_etat_code' });

      // ── Unicité du nom ────────────────────────────────────────────────────
      //
      // DEUX index PARTIELS et non un seul index composite : en SQL, deux NULL
      // ne sont pas égaux. Un `UNIQUE (organisation_id, nom)` laisserait donc
      // créer autant de « Peinture » standard qu'on veut, puisque leur
      // `organisation_id` vaut NULL — précisément le cas qu'il fallait couvrir.
      //
      // `lower(nom)` : « peinture » et « Peinture » sont le même métier. Sans
      // cela, le catalogue se remplit de doublons de casse que personne ne
      // remarque avant de les voir dans une liste déroulante.
      //
      // `deleted_at IS NULL` : le modèle est `paranoid`. Sans cette clause, un
      // corps d'état supprimé continuerait d'interdire la création d'un
      // homonyme, sans que rien à l'écran ne l'explique.
      await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX corps_etat_nom_standard_unique
        ON corps_etat (lower(nom))
        WHERE organisation_id IS NULL AND deleted_at IS NULL;
      `);
      await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX corps_etat_nom_organisation_unique
        ON corps_etat (organisation_id, lower(nom))
        WHERE organisation_id IS NOT NULL AND deleted_at IS NULL;
      `);
    }

    // ── Remplissage du catalogue standard ─────────────────────────────────
    //
    // Conditionné au CONTENU et non à l'existence de la table : un échec
    // survenant entre le `createTable` et l'insertion laisserait sinon une
    // table créée mais vide, que la garde ci-dessus ferait ensuite sauter à
    // chaque rejeu — plus aucun métier proposé au formulaire de réserve, et
    // rien pour le signaler.
    //
    // Ne réinsère pas ce que l'administrateur aurait délibérément supprimé :
    // seule une table entièrement vide est réamorcée.
    const [{ total }] = await queryInterface.sequelize.query(
      'SELECT COUNT(*)::int AS total FROM corps_etat WHERE organisation_id IS NULL',
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    if (total > 0) return;

    // Identifiants générés en JS plutôt que confiés au `DEFAULT` de la
    // colonne : `bulkInsert` cite explicitement toutes les clés de l'objet, la
    // valeur par défaut de `id` ne se déclencherait donc jamais, et un
    // `Sequelize.literal` glissé dans les valeurs n'est pas interpolé de façon
    // fiable selon les versions.
    const maintenant = new Date();
    await queryInterface.bulkInsert('corps_etat', CATALOGUE.map(([code, nom, description], i) => ({
      id: randomUUID(),
      organisation_id: null,
      nom,
      code,
      description,
      ordre: (i + 1) * 10, // pas de 10 : on peut intercaler sans tout renuméroter
      actif: true,
      created_at: maintenant,
      updated_at: maintenant,
      deleted_at: null,
    })));
  },

  async down(queryInterface) {
    await queryInterface.dropTable('corps_etat');
  },
};
