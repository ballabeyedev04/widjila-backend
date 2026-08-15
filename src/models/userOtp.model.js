const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

const UserOtp = sequelize.define('UserOtp', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  utilisateurId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  otpHash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  tableName: 'user_otps',
  timestamps: true,
  underscored: true
});

module.exports = UserOtp;
