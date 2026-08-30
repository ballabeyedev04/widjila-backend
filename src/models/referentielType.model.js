'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Fabrique des référentiels de TYPE — types de document, d'intervenant,
 * d'inspection.
 *
 * ── Ce qu'ils remplacent ──────────────────────────────────────────────────
 * Ces trois listes étaient des colonnes `ENUM` PostgreSQL, recopiées à la
 * main dans le web. Un client BTP qui voulait ajouter « PPSPS » ou
 * « pré-réception » devait attendre une migration et un déploiement. Elles
 * deviennent des tables administrables, sur le modèle des corps d'état.
 *
 * ── Pourquoi une fabrique ─────────────────────────────────────────────────
 * Les trois référentiels ont exactement la même structure et les mêmes
 * règles. Trois fichiers identiques à un nom de table près se seraient mis à
 * diverger au premier correctif appliqué à un seul des trois.
 *
 * ── Le CODE est la clé, pas l'identifiant ─────────────────────────────────
 * `documents.type` contient déjà `plan`, `contrat`… et une partie du code
 * teste ces valeurs (`type === 'plan'`). La colonne métier garde donc le
 * CODE ; ce référentiel dit quels codes sont valides et comment les nommer.
 *
 * C'est un choix délibéré contre une clé étrangère vers l'identifiant : une
 * migration vers des UUID aurait demandé de réécrire chaque comparaison, dans
 * le backend, le web et le mobile — pour un bénéfice nul, le code étant déjà
 * unique et stable.
 *
 * ── PORTÉE (`organisationId`) ─────────────────────────────────────────────
 *   - `null` → catalogue STANDARD fourni par la plateforme, visible de toutes
 *     les organisations, modifiable par le seul super-admin ;
 *   - renseigné → type PROPRE à une organisation, qu'elle gère elle-même.
 *
 * Même convention que `corpsEtat` et `phase`.
 *
 * @param {string} nomModele  Nom Sequelize (`TypeDocument`…)
 * @param {string} nomTable   Table SQL (`types_document`…)
 */
function definirReferentielType(nomModele, nomTable) {
  return sequelize.define(nomModele, {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    // null = catalogue standard de la plateforme (voir l'en-tête).
    organisationId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    /**
     * Clé stable stockée dans la colonne métier (`documents.type`…).
     *
     * OBLIGATOIRE ici, contrairement aux corps d'état : c'est elle qui est
     * écrite dans la donnée. Un type sans code ne pourrait être attribué à
     * rien.
     */
    code: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    nom: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    /**
     * Rang d'affichage. Les types se lisent dans un ordre métier — un plan
     * avant une notice — que l'ordre alphabétique ne rend pas.
     */
    ordre: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    /**
     * Un type retiré est DÉSACTIVÉ, pas supprimé : les documents déjà classés
     * gardent leur libellé, le type cesse simplement d'être proposé.
     */
    actif: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    tableName: nomTable,
    timestamps: true,
    paranoid: true,
    underscored: true,
    indexes: [
      { fields: ['organisation_id'] },
      { fields: ['actif'] },
      { fields: ['code'] }
      // Les index d'unicité (standard / par organisation) sont PARTIELS —
      // Sequelize ne sait pas les décrire ici. Voir la migration
      // 20260830000001-referentiels-types.js.
    ]
  });
}

module.exports = definirReferentielType;
