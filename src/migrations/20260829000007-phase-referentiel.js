'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Migration : la table `phases` devient AUSSI un référentiel.
 *
 * ── Pourquoi réutiliser `phases` plutôt que créer une table ────────────────
 * `phases` existe déjà, avec `nom`, `description`, `ordre`, un CRUD complet et
 * ses écrans. Elle ne servait jusqu'ici qu'au PLANNING d'un chantier donné
 * (dates de début/fin, statut planifiée/en cours/terminée).
 *
 * Le client demande en plus un RÉFÉRENTIEL de phases — Pré-cloisons, Cloisons,
 * OPR, Réception, GPA… — administrable, ordonné, et auquel chaque réserve doit
 * obligatoirement se rattacher. Ce sont les mêmes attributs (nom, ordre,
 * description) : créer une seconde table aurait dupliqué le modèle, les
 * routes, les écrans, et surtout la question « laquelle fait foi ? ».
 *
 * On distingue donc les deux usages par `chantier_id`, exactement comme
 * `corps_etat` distingue le catalogue standard par `organisation_id` :
 *
 *   chantier_id RENSEIGNÉ → phase de planning d'un chantier (comportement
 *                           historique, strictement inchangé) ;
 *   chantier_id NULL      → phase du RÉFÉRENTIEL, proposée à la création
 *                           d'une réserve.
 *
 * `organisation_id` joue le même rôle qu'ailleurs : NULL = référentiel
 * standard de la plateforme, renseigné = phase propre à une organisation.
 *
 * ── Non-régression ────────────────────────────────────────────────────────
 * `ChantierService.listPhases` filtre sur `chantierId` : les lignes du
 * référentiel (chantier_id NULL) ne remontent donc PAS dans le planning d'un
 * chantier, et le calendrier existant est inchangé. Symétriquement,
 * `Phase.destroy({ where: { chantierId } })` de la suppression d'un chantier
 * ne touche jamais le référentiel.
 */

/**
 * Référentiel demandé par le client, DANS SON ORDRE — de la préparation à la
 * garantie décennale. L'ordre est stocké explicitement (`ordre`) et non déduit
 * du nom ou de la date de création : c'est lui qui pilote l'affichage, et
 * l'administrateur doit pouvoir le changer.
 */
const REFERENTIEL = [
  ['Pré-cloisons', 'Contrôles avant pose des cloisons.'],
  ['Cloisons', 'Contrôles après pose des cloisons.'],
  ['Pré-livraison', 'Contrôles préparatoires à la livraison.'],
  ['OPR', 'Opérations préalables à la réception.'],
  ['Réception', 'Réception des travaux.'],
  ['Livraison', 'Livraison au client.'],
  ['30 jours', 'Levée des réserves dans le mois suivant la réception.'],
  ['GPA', 'Garantie de parfait achèvement (1 an).'],
  ['Biennale', 'Garantie biennale de bon fonctionnement (2 ans).'],
  ['Décennale', 'Garantie décennale (10 ans).'],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('phases');

    // ── 1. `chantier_id` devient facultatif ───────────────────────────────
    // Une phase du référentiel n'appartient à aucun chantier : elle est
    // proposée sur tous.
    if (table.chantier_id && table.chantier_id.allowNull === false) {
      await queryInterface.changeColumn('phases', 'chantier_id', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }

    // ── 2. Portée et activation ───────────────────────────────────────────
    if (!table.organisation_id) {
      await queryInterface.addColumn('phases', 'organisation_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'organisations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      });
      await queryInterface.addIndex('phases', ['organisation_id'], { name: 'phases_organisation_id' });
    }

    if (!table.actif) {
      // Une phase retirée du référentiel est DÉSACTIVÉE, jamais supprimée :
      // les réserves déjà rattachées gardent leur phase d'origine, et la
      // phase cesse simplement d'être proposée à la création.
      await queryInterface.addColumn('phases', 'actif', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
      await queryInterface.addIndex('phases', ['actif'], { name: 'phases_actif' });
    }

    // ── 3. Unicité du nom AU SEIN DU RÉFÉRENTIEL ──────────────────────────
    //
    // Index PARTIELS, restreints aux lignes de référentiel : les phases de
    // planning d'un chantier ne sont pas concernées (deux chantiers ont tous
    // les deux le droit d'avoir une phase « Gros œuvre »).
    //
    // `lower(nom)` : « OPR » et « opr » sont la même phase. `deleted_at IS
    // NULL` : le modèle est `paranoid`, sans quoi une phase supprimée
    // interdirait à jamais de recréer son homonyme.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS phases_referentiel_standard_unique
        ON phases (lower(nom))
        WHERE chantier_id IS NULL AND organisation_id IS NULL AND deleted_at IS NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS phases_referentiel_organisation_unique
        ON phases (organisation_id, lower(nom))
        WHERE chantier_id IS NULL AND organisation_id IS NOT NULL AND deleted_at IS NULL;
    `);

    // ── 4. Remplissage du référentiel standard ────────────────────────────
    // Idempotent : on ne réinsère pas si le référentiel existe déjà, pour que
    // rejouer la migration ne crée pas de doublons.
    const [dejaLa] = await queryInterface.sequelize.query(
      "SELECT COUNT(*)::int AS n FROM phases WHERE chantier_id IS NULL AND organisation_id IS NULL AND deleted_at IS NULL;"
    );
    if ((dejaLa[0] && dejaLa[0].n) > 0) return;

    const maintenant = new Date();
    await queryInterface.bulkInsert('phases', REFERENTIEL.map(([nom, description], i) => ({
      id: randomUUID(),
      chantier_id: null,
      organisation_id: null,
      nom,
      description,
      ordre: (i + 1) * 10, // pas de 10 : on intercale sans tout renuméroter
      date_debut: null,
      date_fin: null,
      // `statut` reste la colonne du PLANNING. Sur une ligne de référentiel
      // elle n'a pas de sens ; on garde la valeur par défaut plutôt que
      // d'inventer une signification qu'aucun écran ne lirait.
      statut: 'planifiee',
      actif: true,
      created_at: maintenant,
      updated_at: maintenant,
      deleted_at: null,
    })));
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'DELETE FROM phases WHERE chantier_id IS NULL AND organisation_id IS NULL;'
    );
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS phases_referentiel_standard_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS phases_referentiel_organisation_unique;');

    const table = await queryInterface.describeTable('phases');
    if (table.actif) await queryInterface.removeColumn('phases', 'actif');
    if (table.organisation_id) await queryInterface.removeColumn('phases', 'organisation_id');

    // On ne restaure PAS le NOT NULL sur `chantier_id` : si des lignes de
    // référentiel subsistaient, la migration inverse échouerait au milieu.
  },
};
