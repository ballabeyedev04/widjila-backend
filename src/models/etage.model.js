const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { TYPE_NIVEAU } = require('../config/enums.js');

/**
 * Étage / niveau — second niveau de décomposition.
 * Exemple : "RDC", "Étage 1", "Sous-sol -1".
 */
const Etage = sequelize.define('Etage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  batimentId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  nom: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  niveau: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0
  },
  /**
   * Nature du niveau — `sous_sol`, `etage` ou `toiture`.
   *
   * Distinct de `niveau`, qui est une COTE (entier). Une cote ne dit pas
   * qu'un niveau est une toiture, et c'est pourtant l'une des trois sections
   * de l'écran de dépôt de plans. Jusqu'ici, le seul moyen de reconnaître une
   * toiture était de chercher le mot dans son nom — ce que faisait le mobile,
   * et qui échouait dès qu'un client écrivait « Terrasse » ou « Combles ».
   *
   * Défaut `etage` : c'est le cas le plus fréquent, et les niveaux déjà en
   * base ont été saisis sans distinction.
   */
  typeNiveau: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'etage',
    validate: { isIn: [TYPE_NIVEAU] }
  },
  /**
   * Code choisi dans le référentiel — « SS1 », « RDC », « R+1 ».
   *
   * Facultatif : les étages créés avant ce référentiel n'en ont pas, et rien
   * n'oblige à en attribuer un rétroactivement.
   */
  codeNiveau: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  /**
   * Description saisie au dépôt du plan de ce niveau.
   */
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'etages',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['batiment_id'] },
    { fields: ['type_niveau'] }
  ]
});

module.exports = Etage;
