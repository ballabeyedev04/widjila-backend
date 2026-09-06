'use strict';

// Valeur FIGÉE, et non importée de config/essai.js — comme dans la migration
// 20260814000002, qui garde son propre 7. Une migration décrit ce qui a été
// appliqué à une date donnée ; la brancher sur une constante vivante ferait
// silencieusement changer son effet sur les bases créées plus tard, le jour où
// la durée commerciale évoluera. Faire évoluer la durée = écrire une nouvelle
// migration, pas réécrire l'histoire de celle-ci.
const TRIAL_JOURS = 2;

/**
 * L'essai gratuit démarre à la VALIDATION, et dure désormais 2 jours.
 *
 * ── Le défaut qu'on corrige ───────────────────────────────────────────────
 *
 * `trial_ends_at` était posé à l'inscription, à « maintenant + 7 jours ». Or
 * l'inscription publique ne donne pas un compte utilisable : elle dépose une
 * demande, et la connexion est refusée jusqu'à la décision du super-admin.
 * L'essai s'écoulait donc pendant l'attente, sans que l'entreprise puisse
 * s'en servir — et une validation au-delà du délai la faisait arriver sur
 * « votre période d'essai est terminée » à sa toute première connexion.
 *
 * Le code ne pose plus de date à l'inscription (auth.service.js#register) et
 * la pose à la validation (essai.service.js#demarrerEssai).
 *
 * ── Ce que fait cette migration ───────────────────────────────────────────
 *
 * 1. Le DÉFAUT SQL de la colonne passe à 2 jours. Il reste nécessaire : il
 *    protège les organisations créées hors du parcours d'inscription
 *    (filiale, agence, création par la plateforme, INSERT hors ORM), pour
 *    lesquelles NULL vaudrait accès gratuit sans fin — la faille corrigée par
 *    la migration 20260814000002.
 *
 * 2. Les inscriptions ENCORE EN ATTENTE retrouvent un essai non démarré. Sans
 *    cela, une demande déposée avant ce déploiement garderait son compte à
 *    rebours lancé à l'inscription : c'est exactement la situation qu'on
 *    corrige, et elle survivrait à la correction.
 *
 * Le ciblage de l'étape 2 est volontairement étroit : l'organisation doit
 * avoir au moins un compte en attente, AUCUN compte actif, et ne pas être
 * abonnée. Une organisation en activité n'est jamais touchée — on ne retire
 * d'essai à personne. Une organisation sans aucun utilisateur non plus : la
 * remettre à NULL fermerait la porte au premier compte qu'on y créerait.
 *
 * ── Pourquoi les noms de table et de colonne sont DÉCOUVERTS ──────────────
 *
 * Le schéma réel et les migrations divergent sur ce point précis. Le modèle
 * `User` déclare `tableName: 'utilisateur'` avec `underscored: true`, donc
 * `organisation_id` ; la migration 20260809000001 qui crée la table, elle,
 * pose `organisationId` en camel. Écrire l'un ou l'autre en dur, c'était
 * faire échouer la migration sur la moitié des environnements — avec, en
 * prime, un message parlant d'une relation ou d'une colonne inexistante,
 * qu'on met un moment à relier à un correctif sur l'essai gratuit.
 *
 * L'étape 1, elle, ne dépend d'aucun de ces noms et s'applique toujours.
 */

/** Première table existante parmi `noms`, ou null. */
async function trouverTable(sequelize, noms) {
  const [lignes] = await sequelize.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN (${noms.map((n) => `'${n}'`).join(', ')});
  `);
  const trouvees = lignes.map((l) => l.table_name);
  return noms.find((n) => trouvees.includes(n)) || null;
}

/** Première colonne existante parmi `noms` sur `table`, ou null. */
async function trouverColonne(sequelize, table, noms) {
  const [lignes] = await sequelize.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = '${table}'
       AND column_name IN (${noms.map((n) => `'${n}'`).join(', ')});
  `);
  const trouvees = lignes.map((l) => l.column_name);
  return noms.find((n) => trouvees.includes(n)) || null;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // ── 1. Nouvelle durée par défaut ───────────────────────────────────────
    await sequelize.query(`
      ALTER TABLE organisations
        ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '${TRIAL_JOURS} days');
    `);

    // ── 2. Les demandes non tranchées repartent d'un essai non démarré ─────
    const table = await trouverTable(sequelize, ['utilisateur', 'utilisateurs']);
    if (!table) {
      console.log('[migration] Table des utilisateurs introuvable — étape 2 ignorée.');
      return;
    }

    const colonneOrg = await trouverColonne(sequelize, table, ['organisation_id', 'organisationId']);
    if (!colonneOrg) {
      console.log(`[migration] Colonne d'organisation introuvable sur "${table}" — étape 2 ignorée.`);
      return;
    }

    // `deleted_at` : les modèles sont `paranoid`. Un compte supprimé ne doit
    // ni retenir une organisation « en attente », ni la faire passer pour
    // active. La colonne est cherchée, pas supposée, pour la même raison que
    // les deux précédentes.
    const colonneSuppr = await trouverColonne(sequelize, table, ['deleted_at', 'deletedAt']);
    const vivant = colonneSuppr ? `AND u."${colonneSuppr}" IS NULL` : '';

    const [, resultat] = await sequelize.query(`
      UPDATE organisations o
         SET trial_ends_at = NULL
       WHERE o.is_subscribed = false
         AND EXISTS (
               SELECT 1 FROM "${table}" u
                WHERE u."${colonneOrg}" = o.id
                  AND u.statut = 'en_attente_validation'
                  ${vivant}
             )
         AND NOT EXISTS (
               SELECT 1 FROM "${table}" u
                WHERE u."${colonneOrg}" = o.id
                  AND u.statut = 'actif'
                  ${vivant}
             );
    `);

    const touchees = resultat?.rowCount ?? 0;
    console.log(`[migration] Essai remis à « non démarré » pour ${touchees} organisation(s) en attente de validation.`);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // Le défaut revient à 7 jours.
    await sequelize.query(`
      ALTER TABLE organisations
        ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '7 days');
    `);

    // Les NULL posés à l'étape 2 ne sont PAS restaurés : rien ne distingue
    // après coup une organisation remise à NULL ici d'une inscription déposée
    // depuis. Reposer une date arbitraire inventerait un essai déjà entamé
    // pour des entreprises qui ne se sont jamais connectées.
  },
};
