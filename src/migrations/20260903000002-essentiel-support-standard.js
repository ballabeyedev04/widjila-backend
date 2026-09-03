'use strict';

/**
 * Aligne la formule Essentiel sur la présentation commerciale du client.
 *
 * ── L'écart ───────────────────────────────────────────────────────────────
 * Le catalogue semé donnait `support_prioritaire` à Essentiel. La
 * présentation commerciale, elle, est explicite :
 *
 *   Essentiel — « Levé de réserves illimité, export PDF, support standard »
 *   Pro       — « … support prioritaire »
 *
 * La carte de formule affichait donc « Support prioritaire » à un client
 * Essentiel : une promesse commerciale que le document ne fait pas.
 *
 * ── Portée ────────────────────────────────────────────────────────────────
 * Purement ce qui est AFFICHÉ. `support_prioritaire` ne garde aucune route :
 * aucun `requireFonctionnalite` ne s'en sert. Aucun accès n'est retiré à
 * personne, aucune organisation ne perd une capacité.
 *
 * ── Réversibilité ─────────────────────────────────────────────────────────
 * `down()` remet la mention. Les deux sens sont écrits en SQL sur le tableau
 * JSON, sans toucher aux autres fonctionnalités ni aux autres formules.
 */

module.exports = {
  async up(queryInterface) {
    const [lignes] = await queryInterface.sequelize.query(
      `SELECT id, fonctionnalites FROM "plans_abonnement" WHERE code = 'essentiel'`
    );
    if (!lignes.length) return;

    for (const ligne of lignes) {
      const actuelles = Array.isArray(ligne.fonctionnalites) ? ligne.fonctionnalites : [];
      if (!actuelles.includes('support_prioritaire')) continue;

      const retenues = actuelles.filter((f) => f !== 'support_prioritaire');
      await queryInterface.sequelize.query(
        `UPDATE "plans_abonnement" SET "fonctionnalites" = :liste WHERE id = :id`,
        { replacements: { liste: JSON.stringify(retenues), id: ligne.id } }
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
      if (actuelles.includes('support_prioritaire')) continue;

      await queryInterface.sequelize.query(
        `UPDATE "plans_abonnement" SET "fonctionnalites" = :liste WHERE id = :id`,
        {
          replacements: {
            liste: JSON.stringify([...actuelles, 'support_prioritaire']),
            id: ligne.id,
          },
        }
      );
    }
  },
};
