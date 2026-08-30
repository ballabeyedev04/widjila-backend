const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Corps d'état — le catalogue des métiers / types de travaux du BTP
 * (démolitions, gros œuvre, plomberie, serrurerie…).
 *
 * POURQUOI UNE TABLE ET PAS UN ENUM : la catégorie d'une réserve vivait dans
 * un ENUM PostgreSQL de dix valeurs, recopié à l'identique dans la validation
 * Joi, dans les constantes du web et dans une énumération Dart du mobile.
 * Ajouter « Serrurerie » imposait donc une migration, un déploiement backend,
 * une livraison web ET une mise à jour du magasin d'applications — pour une
 * donnée de référence qui, sur un chantier, change au gré des marchés.
 *
 * PORTÉE (`organisationId`) :
 *   - `null` → catalogue STANDARD, fourni par la plateforme et visible par
 *     toutes les organisations. Seul le super-admin le modifie ;
 *   - renseigné → métier PROPRE à une organisation, qu'elle gère elle-même.
 * Une organisation voit donc « le standard + le sien », sans qu'on ait eu à
 * recopier trente lignes de catalogue dans chaque compte créé.
 *
 * À NE PAS CONFONDRE avec `Lot` : un lot est une ligne de marché DANS un
 * chantier donné (« 3A - Couverture », avec son entreprise et son
 * interlocuteur). Le corps d'état est le référentiel auquel les lots et les
 * réserves se rattachent, commun à tous les chantiers.
 */
const CorpsEtat = sequelize.define('CorpsEtat', {
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
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  /**
   * Clé stable et lisible (`maconnerie`, `gros_oeuvre`…).
   *
   * C'est elle qui fait le pont avec l'ancien ENUM `reserves.categorie` :
   * les dix valeurs historiques existent au catalogue avec le MÊME code, ce
   * qui permet de rattacher les réserves déjà en base sans deviner, et à un
   * client mobile non mis à jour de continuer à envoyer `categorie`.
   */
  code: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /**
   * Rang d'affichage — les corps d'état se lisent dans l'ordre du chantier
   * (démolition, gros œuvre, second œuvre, finitions), pas dans l'ordre
   * alphabétique. Un tri sur le nom mettrait « Peinture » avant « Plomberie »
   * et « Démolitions » au milieu, ce qui ne veut rien dire sur un planning.
   */
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  /**
   * Un corps d'état retiré du catalogue est DÉSACTIVÉ, pas supprimé : les
   * réserves déjà rattachées gardent ainsi leur libellé, et il cesse
   * simplement d'être proposé dans les formulaires.
   */
  actif: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  }
}, {
  tableName: 'corps_etat',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['actif'] },
    { fields: ['code'] }
    // Les deux index d'unicité (standard / par organisation) sont posés par la
    // migration : ce sont des index PARTIELS, que Sequelize ne sait pas
    // décrire ici. Voir 20260829000005-create-corps-etat.js.
  ]
});

module.exports = CorpsEtat;
