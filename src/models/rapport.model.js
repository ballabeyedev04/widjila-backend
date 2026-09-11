const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Rapport — cahier des charges « Rapports de réserves » (§ 12, table REPORT).
 *
 * Un rapport est d'abord une CONFIGURATION : un modèle, des filtres, des
 * sections, des formats. La génération en tire un fichier figé, qui reflète
 * l'état des données à cet instant — c'est ce qui en fait une pièce
 * transmissible, et c'est pourquoi elle ne se recalcule jamais après coup.
 *
 * Le cycle de vie suit les sept états du § 19 : brouillon → en_attente →
 * generation → genere → envoye, avec `echec` en cas d'erreur et `archive`
 * pour une version remplacée par une plus récente.
 */
const Rapport = sequelize.define('Rapport', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  /**
   * Ancien type (visite, opr, reserves, entreprise, batiment, qualite).
   *
   * CONSERVÉ malgré l'arrivée de `modele` : l'espace web et les versions du
   * mobile déjà installées lisent cette colonne pour libeller la ligne. La
   * retirer aurait affiché « undefined » sur tous les rapports d'un client
   * qui n'a pas encore mis à jour son application.
   */
  type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  /** Nom donné au rapport (§ 10, `name`) — « Rapport Bâtiment A ». */
  nom: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  /** Modèle du § 5 : GLOBAL, BATIMENT, ETAGE_ZONE, ENTREPRISE… */
  modele: {
    type: DataTypes.STRING(30),
    allowNull: true
  },
  /** État technique du § 19. */
  statut: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'brouillon'
  },
  /**
   * Fichier PDF produit. NUL tant que le rapport n'est qu'un brouillon —
   * inventer une URL vide rendrait un rapport non généré indiscernable d'un
   * rapport dont le fichier a disparu.
   */
  fichier_url: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /** Fichier Excel, quand le format XLSX a été demandé (§ 4). */
  fichier_xlsx_url: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /** Formats demandés : ['PDF'], ['XLSX'] ou les deux. */
  formats: {
    type: DataTypes.JSON,
    allowNull: true
  },
  /** Sections activées (§ 10) : summary, plans, photos, location, history. */
  sections: {
    type: DataTypes.JSON,
    allowNull: true
  },
  /** Filtres retenus (§ 4), sous la forme envoyée par le client. */
  filtres: {
    type: DataTypes.JSON,
    allowNull: true
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  /**
   * Version PRÉCÉDENTE de ce rapport.
   *
   * Régénérer un rapport DÉJÀ DIFFUSÉ ne remplace pas son fichier : cela crée
   * une nouvelle ligne qui pointe ici vers l'ancienne. Le § 18 l'exige — « ne
   * jamais écraser silencieusement l'historique d'un rapport déjà diffusé » —
   * et c'est ce qui permet de retrouver le document exact reçu par une
   * entreprise le mois dernier.
   */
  rapportParentId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  generePar: {
    type: DataTypes.UUID,
    allowNull: true
  },
  genere_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  taille_pdf: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  nb_reserves: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  /** Motif de l'échec, quand `statut = 'echec'`. */
  erreur: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /** Entreprise visée, pour un rapport produit « par entreprise » (§ 15). */
  partenaireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /** Regroupe les rapports issus d'une même commande « par entreprise ». */
  lotGenerationId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Paramètres de génération de l'ancien point d'entrée — traçabilité.
  parametres: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'rapports',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['statut'] },
    { fields: ['lot_generation_id'] }
  ]
});

module.exports = Rapport;
