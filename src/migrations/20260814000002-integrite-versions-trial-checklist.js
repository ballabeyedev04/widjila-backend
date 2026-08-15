'use strict';

/**
 * Migration : intégrité des données (audit § 4, § 6, § 7).
 *
 * 1. checklists.deleted_at — Checklist devient paranoid. Sans cette colonne,
 *    supprimer une inspection (soft delete) laissait ses lignes de contrôle
 *    actives et orphelines : `onDelete: CASCADE` est une contrainte SQL, elle
 *    ne se déclenche jamais sur un `UPDATE deleted_at`.
 *
 * 2. plans (chantier_id, nom, version) et documents (chantier_id, nom_fichier,
 *    version) deviennent uniques. Le versionnement était calculé par
 *    `findOne(order DESC) + 1` sans verrou ni contrainte : deux téléversements
 *    simultanés produisaient deux fois la même version, et — les deux modèles
 *    étant paranoid — supprimer la dernière version faisait réutiliser son
 *    numéro. Les index posés ici couvrent aussi les lignes soft-deleted
 *    (Postgres indexe toutes les lignes), donc un numéro consommé ne revient
 *    plus jamais.
 *    Les doublons éventuellement déjà présents sont renumérotés AVANT la pose
 *    de l'index, sinon sa création échouerait. La renumérotation est
 *    déterministe (ordre version, created_at, id) et n'affecte aucune
 *    référence : les réserves pointent sur `plans.id`, pas sur le numéro.
 *
 * 3. organisations.trial_ends_at — NULL valait accès gratuit permanent :
 *    `checkSubscription` calcule `trialEnded = trial_ends_at && …`, donc NULL
 *    ⇒ falsy ⇒ essai « jamais terminé ». Seul `register` renseignait ce champ.
 *    On borne les lignes existantes (created_at + 7 jours) et on pose un DÉFAUT
 *    SQL, qui protège aussi les INSERT effectués hors ORM.
 */

const TRIAL_JOURS = 7;

module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

    // ── 1. Checklist paranoid ────────────────────────────────────────────────
    const colonnesChecklist = await queryInterface.describeTable('checklists');
    if (!colonnesChecklist.deleted_at) {
      await queryInterface.addColumn('checklists', 'deleted_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    // ── 2a. Plans : renumérotation des versions puis unicité ─────────────────
    await sequelize.query(`
      WITH ordonnes AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY chantier_id, nom
                 ORDER BY version, created_at, id
               ) AS rang
          FROM plans
      )
      UPDATE plans p
         SET version = o.rang
        FROM ordonnes o
       WHERE p.id = o.id
         AND p.version <> o.rang;
    `);

    // Déjà présent sur une base neuve (créée par 20260809000000 d'après la
    // forme actuelle du modèle). Code SQLSTATE plutôt que texte du message :
    // un serveur Postgres en locale française ne renvoie jamais "already
    // exists" (testé en conditions réelles).
    try {
      await queryInterface.addIndex('plans', ['chantier_id', 'nom', 'version'], {
        name: 'plans_chantier_nom_version_unique',
        unique: true,
      });
    } catch (err) {
      const code = err?.parent?.code || err?.original?.code;
      const dejaExistant = code === '42710' || /already exists|existe déjà/i.test(err.message || '');
      if (!dejaExistant) throw err;
    }

    // ── 2b. Documents : idem sur (chantier_id, nom_fichier, version) ─────────
    await sequelize.query(`
      WITH ordonnes AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY chantier_id, nom_fichier
                 ORDER BY version, created_at, id
               ) AS rang
          FROM documents
      )
      UPDATE documents d
         SET version = o.rang
        FROM ordonnes o
       WHERE d.id = o.id
         AND d.version <> o.rang;
    `);

    try {
      await queryInterface.addIndex('documents', ['chantier_id', 'nom_fichier', 'version'], {
        name: 'documents_chantier_nom_version_unique',
        unique: true,
      });
    } catch (err) {
      const code = err?.parent?.code || err?.original?.code;
      const dejaExistant = code === '42710' || /already exists|existe déjà/i.test(err.message || '');
      if (!dejaExistant) throw err;
    }

    // ── 3. Essai gratuit borné pour toute organisation ───────────────────────
    await sequelize.query(`
      UPDATE organisations
         SET trial_ends_at = COALESCE(created_at, NOW()) + INTERVAL '${TRIAL_JOURS} days'
       WHERE trial_ends_at IS NULL;
    `);

    await sequelize.query(`
      ALTER TABLE organisations
        ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '${TRIAL_JOURS} days');
    `);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // 3. Retrait du défaut SQL.
    // Note : le remplissage des trial_ends_at qui étaient NULL n'est PAS
    // réversible — rien ne distingue après coup une valeur calculée ici d'une
    // valeur légitime. C'est une correction de données, volontairement
    // conservée au rollback (la remettre à NULL rouvrirait la faille d'accès
    // gratuit permanent).
    await sequelize.query(`
      ALTER TABLE organisations ALTER COLUMN trial_ends_at DROP DEFAULT;
    `);

    // 2. Unicité des versions
    await queryInterface.removeIndex('documents', 'documents_chantier_nom_version_unique');
    await queryInterface.removeIndex('plans', 'plans_chantier_nom_version_unique');

    // 1. Checklist redevient non paranoid
    const colonnesChecklist = await queryInterface.describeTable('checklists');
    if (colonnesChecklist.deleted_at) {
      await queryInterface.removeColumn('checklists', 'deleted_at');
    }
  },
};
