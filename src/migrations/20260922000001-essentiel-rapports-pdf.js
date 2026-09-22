'use strict';

/**
 * Ouvre les rapports PDF à la formule Essentiel.
 *
 * ── L'écart ───────────────────────────────────────────────────────────────
 * La description d'Essentiel annonce « export PDF » (présentation commerciale
 * du client), mais la formule n'avait pas le code `rapports` : la carte ne
 * listait pas « Rapports PDF », et le serveur refusait la génération (403).
 *
 * ── Portée ────────────────────────────────────────────────────────────────
 * Contrairement à `support_prioritaire`, `rapports` GARDE une route :
 * `POST /chantiers/:chantierId/rapports/generer` (`requireFonctionnalite`).
 * Cette migration ouvre donc réellement la génération aux organisations
 * Essentiel — c'est voulu (demande client du 22/09/2026).
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` retire le code. Les deux sens ne touchent qu'au tableau JSON
 * d'Essentiel, sans modifier les autres fonctionnalités ni les autres formules.
 */

module.exports = {
  async up(queryInterface) {
    const [lignes] = await queryInterface.sequelize.query(
      `SELECT id, fonctionnalites FROM "plans_abonnement" WHERE code = 'essentiel'`
    );
    if (!lignes.length) return;

    for (const ligne of lignes) {
      const actuelles = Array.isArray(ligne.fonctionnalites) ? ligne.fonctionnalites : [];
      if (actuelles.includes('rapports')) continue;

      await queryInterface.sequelize.query(
        `UPDATE "plans_abonnement" SET "fonctionnalites" = :liste WHERE id = :id`,
        { replacements: { liste: JSON.stringify([...actuelles, 'rapports']), id: ligne.id } }
      );
    }
  },

  async down(queryInterface) {
    const [lignes] = await queryInterface.sequelize.query(
      `SELECT id, fonctionnalites FROM "plans_abonnement" WHERE code = 'essentiel'`
    );
    if (!lignes.length) return;

    for (const ligne of lignes) {
      const actuelles = Array.isArray(ligne.fonctionnalites) ? ligne.fonctionnalites : [];
      if (!actuelles.includes('rapports')) continue;

      await queryInterface.sequelize.query(
        `UPDATE "plans_abonnement" SET "fonctionnalites" = :liste WHERE id = :id`,
        {
          replacements: {
            liste: JSON.stringify(actuelles.filter((f) => f !== 'rapports')),
            id: ligne.id,
          },
        }
      );
    }
  },
};
