'use strict';

/**
 * Retrait de TROIS corps d'état du catalogue STANDARD : « Démolitions »,
 * « Maçonnerie » et « Couverture ».
 *
 * ── La demande ────────────────────────────────────────────────────────────
 *
 * Le client ne veut plus les voir proposés à la saisie d'une réserve, et a
 * précisé que les cacher côté mobile ne suffisait pas : ils doivent quitter la
 * base, pour que le web, le mobile et l'API disent la même chose.
 *
 * ── Portée : le catalogue STANDARD, et lui seul ───────────────────────────
 *
 * `organisation_id IS NULL` cible les lignes fournies par la plateforme (voir
 * `corpsEtat.model.js`). Une organisation qui aurait créé SON propre
 * « Couverture » le garde : c'est sa donnée, pas celle de la plateforme, et
 * rien ne dit qu'elle veut la perdre. Les vingt-deux autres métiers standards
 * ne sont pas touchés.
 *
 * ── Deux issues, selon ce que la base contient réellement ─────────────────
 *
 * `reserves.corps_etat_id` référence ce catalogue en `ON DELETE SET NULL`
 * (migration 20260829000006). Un DELETE ne casserait donc aucune réserve —
 * mais il effacerait le métier des réserves déjà relevées, et « Démolitions »
 * comme « Couverture » n'existent PAS dans l'ancien ENUM `reserves.categorie`
 * qui sert de repli : l'information serait perdue pour de bon.
 *
 * D'où la règle, appliquée métier par métier :
 *
 *   - AUCUNE réserve ne le référence → DELETE. Il quitte la base, comme
 *     demandé, et rien ne le regrette.
 *
 *   - des réserves le référencent → il est DÉSACTIVÉ (`actif = false`). Il
 *     disparaît de `/corps-etat/actifs`, donc de toutes les listes
 *     déroulantes du web et du mobile — ce qui est l'objectif — mais les
 *     réserves déjà relevées gardent leur libellé.
 *
 * On ne SOFT-DELETE pas ce second cas : le modèle est `paranoid`, et une ligne
 * supprimée disparaîtrait aussi des jointures qui affichent le métier d'une
 * réserve existante. Le détail d'une réserve « Couverture » n'afficherait plus
 * aucun métier, sans que personne l'ait demandé.
 *
 * Le résultat est journalisé : c'est la seule façon de savoir, après coup,
 * lequel des deux chemins a été pris sur une base donnée.
 */

const CODES = ['demolitions', 'maconnerie', 'couverture'];

module.exports = {
  async up(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('corps_etat');
    if (!existe) return; // base antérieure au catalogue — rien à retirer.

    const [lignes] = await queryInterface.sequelize.query(
      `
      SELECT c.id,
             c.code,
             c.actif,
             (SELECT COUNT(*) FROM reserves r WHERE r.corps_etat_id = c.id)::int AS utilisations
        FROM corps_etat c
       WHERE c.organisation_id IS NULL
         AND c.code IN (:codes)
      `,
      { replacements: { codes: CODES } }
    );

    if (!lignes || lignes.length === 0) return;

    const aSupprimer = lignes.filter((l) => l.utilisations === 0).map((l) => l.id);
    const aDesactiver = lignes.filter((l) => l.utilisations > 0).map((l) => l.id);

    if (aSupprimer.length > 0) {
      // `force` : suppression PHYSIQUE, pas un simple `deleted_at`. Le client
      // a demandé qu'ils quittent la base, et aucune réserve ne les référence.
      await queryInterface.sequelize.query(
        'DELETE FROM corps_etat WHERE id IN (:ids)',
        { replacements: { ids: aSupprimer } }
      );
    }

    if (aDesactiver.length > 0) {
      await queryInterface.sequelize.query(
        'UPDATE corps_etat SET actif = false, updated_at = NOW() WHERE id IN (:ids)',
        { replacements: { ids: aDesactiver } }
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[corps_etat] Retrait Démolitions / Maçonnerie / Couverture — `
      + `${aSupprimer.length} supprimé(s), ${aDesactiver.length} désactivé(s) `
      + `(encore référencé(s) par des réserves).`
    );
  },

  /**
   * Le retour en arrière RÉACTIVE ce qui a été désactivé, et RECRÉE ce qui a
   * été supprimé — avec les libellés exacts de la migration d'origine
   * (20260829000005), pour que le catalogue standard redevienne ce qu'il était.
   *
   * `ordre` : recalculé à partir du voisin le plus proche resté en place, de
   * sorte que les trois métiers reviennent à peu près à leur rang dans l'ordre
   * du chantier plutôt qu'à la fin de la liste.
   */
  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const existe = tables
      .map((t) => (typeof t === 'string' ? t : t.tableName))
      .includes('corps_etat');
    if (!existe) return;

    await queryInterface.sequelize.query(
      'UPDATE corps_etat SET actif = true, updated_at = NOW() '
      + 'WHERE organisation_id IS NULL AND code IN (:codes)',
      { replacements: { codes: CODES } }
    );

    const RECREER = [
      ['demolitions', 'Démolitions', 'Dépose et démolition des ouvrages existants.', 'terrassement'],
      ['maconnerie', 'Maçonnerie', 'Ouvrages maçonnés, reprises et scellements.', 'charpente'],
      ['couverture', 'Couverture', 'Couverture, zinguerie et évacuation des eaux pluviales.', 'etancheite'],
    ];

    for (const [code, nom, description, voisin] of RECREER) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO corps_etat (id, organisation_id, nom, code, description, ordre, actif, created_at, updated_at)
        SELECT gen_random_uuid(), NULL, :nom, :code, :description,
               COALESCE((SELECT ordre FROM corps_etat WHERE organisation_id IS NULL AND code = :voisin), 0),
               true, NOW(), NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM corps_etat WHERE organisation_id IS NULL AND code = :code
         )
        `,
        { replacements: { nom, code, description, voisin } }
      );
    }
  },
};
