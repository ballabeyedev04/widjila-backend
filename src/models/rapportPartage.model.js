const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Lien de partage sécurisé d'un rapport — cahier des charges § 14.
 *
 * Le document fixe six exigences, et chacune a sa colonne :
 *   - unique et difficile à deviner  → jeton de 32 octets aléatoires ;
 *   - associé au report_id           → `rapportId` ;
 *   - révocable                      → `revoque_le` ;
 *   - limité dans le temps           → `expire_le` (facultatif) ;
 *   - protégé par authentification   → `authentification_requise` ;
 *   - accès journalisés              → `nb_acces`, `dernier_acces_le`, et une
 *                                      ligne d'historique par consultation.
 *
 * ── Seule l'EMPREINTE du jeton est stockée ─────────────────────────────────
 *
 * Le jeton en clair n'existe qu'une fois : dans la réponse à la demande de
 * partage. La base ne garde que son SHA-256, comme pour un mot de passe. Une
 * copie de la base ne rend donc pas utilisables les liens déjà distribués —
 * or ces liens ouvrent des documents contractuels, sans authentification.
 */
const RapportPartage = sequelize.define('RapportPartage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  rapportId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  token_hash: {
    type: DataTypes.STRING(64),
    allowNull: false
  },
  creePar: {
    type: DataTypes.UUID,
    allowNull: true
  },
  expire_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  revoque_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  authentification_requise: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  nb_acces: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  dernier_acces_le: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'rapport_partages',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['token_hash'] },
    { fields: ['rapport_id'] }
  ]
});

/** Vrai si ce lien peut encore servir — ni révoqué, ni expiré. */
RapportPartage.prototype.estValide = function estValide(maintenant = new Date()) {
  if (this.revoque_le) return false;
  if (this.expire_le && new Date(this.expire_le) <= maintenant) return false;
  return true;
};

module.exports = RapportPartage;
