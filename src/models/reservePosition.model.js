const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Position exacte d'une réserve sur un plan.
 *
 * `x` et `y` sont des POURCENTAGES de l'image (0-100), jamais des pixels.
 * C'est ce qui garde un repère à sa place quand l'écran change de taille,
 * quand l'orientation tourne, quand on passe d'un téléphone à une tablette ou
 * quand l'utilisateur zoome : le même plan est affiché à toutes les
 * résolutions, et une valeur en pixels ne voudrait rien dire d'un appareil à
 * l'autre.
 *
 * L'ancienne mention « coordonnées écran » disait le contraire de ce que le
 * code fait ; les deux clients envoient bien des pourcentages
 * (`plan_interactif.dart`, `PlanCanvas.jsx`), et les bornes sont imposées à
 * l'entrée par `reserve.validation.js`.
 *
 * Règle métier : une réserve est liée à une position précise sur un plan.
 */
const ReservePosition = sequelize.define('ReservePosition', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  reserveId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true
  },
  x: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  y: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0
  },
  zoom: {
    type: DataTypes.FLOAT,
    allowNull: true,
    defaultValue: 1
  },
  /**
   * PAGE du document sur laquelle la réserve a été posée — cahier technique
   * § 6 (« changement de page si le PDF en contient plusieurs ») et § 18
   * (« Plan multi-page → bonne page associée à la réserve »).
   *
   * Sans elle, les réserves d'un PDF de douze pages se dessinaient TOUTES sur
   * la page affichée, quelle qu'elle soit : chacune à ses bonnes coordonnées,
   * mais sur la mauvaise page. Un repère faux est pire qu'un repère absent —
   * il envoie quelqu'un constater un défaut là où il n'y en a pas.
   *
   * Défaut `1` : un plan d'une seule page est le cas courant, et toutes les
   * réserves déjà posées l'ont été sur la première.
   */
  page: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  }
}, {
  tableName: 'reserve_positions',
  timestamps: true,
  underscored: true
});

module.exports = ReservePosition;
