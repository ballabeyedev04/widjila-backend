'use strict';

/**
 * Intégrité des abonnements, garantie par la BASE.
 *
 * 1. « Au plus UNE souscription active par organisation. »
 *    Le code l'appliquait par une suite d'écritures sans transaction : deux
 *    activations simultanées expiraient chacune la ligne de l'autre (plus
 *    aucune active pour une organisation qui a payé), un arrêt au milieu en
 *    laissait deux. Le service sérialise désormais les activations
 *    (subscription.service.js#_activerSousVerrou) ; cet index est le filet
 *    qui rend l'état impossible, quel que soit le chemin d'écriture.
 *
 *    Les doublons ÉVENTUELS déjà en base sont résolus avant de poser l'index
 *    (sinon la migration échouerait au déploiement) : on garde la souscription
 *    active la plus récente, les autres passent « expiree » — exactement ce
 *    que le code aurait dû produire.
 *
 * 2. Montants et périodes cohérents (CHECK).
 *    Posés `NOT VALID` : ils s'appliquent à toute ligne NOUVELLE ou MODIFIÉE,
 *    sans vérifier l'existant — une ligne ancienne hors règle ne bloque pas le
 *    déploiement. `VALIDATE CONSTRAINT` pourra être joué plus tard, après
 *    contrôle (scripts/verifierIntegrite.js les liste).
 */

const CONTRAINTES = [
  ['plans_abonnement', 'plans_abonnement_prix_positif', 'prix IS NULL OR prix >= 0'],
  ['abonnements_souscrits', 'abonnements_souscrits_prix_positif', 'prix_paye IS NULL OR prix_paye >= 0'],
  ['abonnements_souscrits', 'abonnements_souscrits_periode_ordonnee',
    'date_debut IS NULL OR date_fin IS NULL OR date_fin >= date_debut'],
  ['abonnements_souscrits', 'abonnements_souscrits_active_datee',
    "statut <> 'active' OR date_debut IS NOT NULL"],
];

module.exports = {
  async up(queryInterface) {
    const q = (sql, options = {}) => queryInterface.sequelize.query(sql, options);
    const t = await queryInterface.sequelize.transaction();
    try {
      // ── 1. Doublons actifs → la plus récente reste active ──────────────
      await q(`
        UPDATE abonnements_souscrits a
           SET statut = 'expiree', updated_at = NOW()
         WHERE a.statut = 'active'
           AND EXISTS (
             SELECT 1 FROM abonnements_souscrits b
              WHERE b.organisation_id = a.organisation_id
                AND b.statut = 'active'
                AND (b.created_at > a.created_at OR (b.created_at = a.created_at AND b.id > a.id))
           )`, { transaction: t });

      await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS abonnements_souscrits_une_active_par_organisation
            ON abonnements_souscrits (organisation_id)
         WHERE statut = 'active'`, { transaction: t });

      // ── 2. Lignes anciennes hors règle → remises en règle ──────────────
      //
      // `NOT VALID` ne dispense QUE la migration : PostgreSQL contrôle toute
      // ligne MODIFIÉE ensuite. Une ancienne ligne hors règle ne pouvait donc
      // plus être mise à jour — et la toute première mise à jour qui la vise
      // est celle du paiement suivant (`_activerSousVerrou` expire l'active
      // courante). Le webhook échouait en 500 et se rejouait sans fin : le
      // client payait sans jamais être activé.
      //
      // Ces lignes existent : l'activation manuelle acceptait une date de fin
      // PASSÉE (date_debut = maintenant > date_fin). Chaque correction garde le
      // sens de la ligne : une période inversée n'a jamais couvert un seul
      // jour, elle est close sur son début.
      await q(`
        UPDATE abonnements_souscrits
           SET date_fin = date_debut,
               statut = CASE WHEN statut = 'active' THEN 'expiree' ELSE statut END,
               updated_at = NOW()
         WHERE date_debut IS NOT NULL AND date_fin IS NOT NULL AND date_fin < date_debut`, { transaction: t });
      await q(`
        UPDATE abonnements_souscrits
           SET date_debut = created_at, updated_at = NOW()
         WHERE statut = 'active' AND date_debut IS NULL`, { transaction: t });
      await q(`
        UPDATE abonnements_souscrits SET prix_paye = NULL, updated_at = NOW()
         WHERE prix_paye < 0`, { transaction: t });
      await q(`
        UPDATE plans_abonnement SET prix = NULL, updated_at = NOW()
         WHERE prix < 0`, { transaction: t });

      // ── 3. CHECK (NOT VALID) ─────────────────────────────────────────────
      for (const [table, nom, expression] of CONTRAINTES) {
        const [existe] = await q(
          'SELECT 1 FROM pg_constraint WHERE conname = :nom',
          { replacements: { nom }, transaction: t }
        );
        if (existe.length) continue;
        await q(`ALTER TABLE ${table} ADD CONSTRAINT ${nom} CHECK (${expression}) NOT VALID`, { transaction: t });
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const [table, nom] of CONTRAINTES) {
      await q(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${nom}`);
    }
    await q('DROP INDEX IF EXISTS abonnements_souscrits_une_active_par_organisation');
  },
};
