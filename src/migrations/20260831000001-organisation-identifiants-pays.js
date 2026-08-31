'use strict';

/**
 * Ajoute les identifiants d'entreprise manquants et normalise le pays.
 *
 * ── Pourquoi ─────────────────────────────────────────────────────────────
 * `organisations` portait `siret`, `num_tva`, `rccm` et `ninea` — de quoi
 * couvrir la France et le Sénégal. Le Mali (NIF) et la Côte d'Ivoire
 * (NCC, IDU) n'avaient aucune colonne : leurs entreprises ne pouvaient pas
 * enregistrer leur identifiant fiscal.
 *
 * ── Le pays devient un CODE ──────────────────────────────────────────────
 * `pays` était un texte libre avec « France » par défaut. Il devient un code
 * ISO 3166-1 alpha-2 (`FR`, `SN`, `ML`, `CI`), qui commande l'affichage des
 * champs d'identification — voir `config/pays.js`.
 *
 * La conversion des valeurs existantes est explicite et limitée aux libellés
 * réellement rencontrés. Toute valeur non reconnue est LAISSÉE TELLE QUELLE :
 * écraser un pays inconnu par « FR » inventerait une donnée, et l'entreprise
 * concernée se verrait proposer les mauvais champs sans que personne ne le
 * remarque.
 *
 * ── Réversibilité ────────────────────────────────────────────────────────
 * `down()` supprime les trois colonnes ajoutées et remet les libellés de pays.
 * Les valeurs de NIF, NCC et IDU sont alors perdues — c'est inhérent à la
 * suppression d'une colonne, et c'est pourquoi un rollback doit être précédé
 * d'une sauvegarde.
 */

const COLONNES = ['nif', 'ncc', 'idu'];

/** Libellés historiques rencontrés en base → code ISO. */
const CONVERSIONS = [
  ["'France'", 'FR'],
  ["'france'", 'FR'],
  ["'FRANCE'", 'FR'],
  ["'Sénégal'", 'SN'],
  ["'Senegal'", 'SN'],
  ["'senegal'", 'SN'],
  ["'Mali'", 'ML'],
  ["'mali'", 'ML'],
  ["'Côte d''Ivoire'", 'CI'],
  ["'Cote d''Ivoire'", 'CI'],
  ["'CI'", 'CI'],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('organisations');

    // ── 1. Les identifiants manquants ────────────────────────────────────
    for (const colonne of COLONNES) {
      if (!table[colonne]) {
        await queryInterface.addColumn('organisations', colonne, {
          type: Sequelize.STRING(50),
          allowNull: true,
        });
      }
    }

    // ── 2. Le pays passe en code ISO ─────────────────────────────────────
    //
    // Fait AVANT de changer la valeur par défaut : sinon les lignes créées
    // entre les deux instructions porteraient l'ancien libellé.
    for (const [libelle, code] of CONVERSIONS) {
      await queryInterface.sequelize.query(
        `UPDATE organisations SET pays = '${code}' WHERE pays = ${libelle};`
      );
    }

    // La LONGUEUR de la colonne reste inchangée.
    //
    // La réduire à VARCHAR(2) aurait tronqué, via `LEFT(pays, 2)`, toute
    // valeur non convertie — exactement les pays inconnus qu'on vient de
    // décider de préserver. « Belgique » serait devenu « Be », une donnée
    // fausse et silencieuse. Seule la valeur par défaut change.
    await queryInterface.sequelize.query(
      "ALTER TABLE organisations ALTER COLUMN pays SET DEFAULT 'FR';"
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE organisations ALTER COLUMN pays SET DEFAULT 'France';"
    );

    for (const [libelle, code] of CONVERSIONS) {
      // Une seule conversion inverse par code — la première de la liste, qui
      // porte l'orthographe de référence.
      await queryInterface.sequelize.query(
        `UPDATE organisations SET pays = ${libelle} WHERE pays = '${code}';`
      );
    }

    const table = await queryInterface.describeTable('organisations');
    for (const colonne of COLONNES) {
      if (table[colonne]) await queryInterface.removeColumn('organisations', colonne);
    }
  },
};
