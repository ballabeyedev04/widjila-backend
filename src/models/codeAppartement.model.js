'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Référentiel des CODES D'APPARTEMENT — « A001 », « A002 », « B12 »…
 *
 * ── Pourquoi un référentiel et non un champ libre ─────────────────────────
 * Le code d'appartement était saisi à la main sur le mobile. Le client a
 * demandé la même mécanique que pour les niveaux : une LISTE proposée, servie
 * par le serveur, et un « + » pour ajouter ce qui manque — l'ajout devenant
 * disponible pour toute l'organisation.
 *
 * Un champ libre produit des jeux de codes divergents dès le deuxième
 * utilisateur : « A001 », « A-001 », « Appt 1 » désignent le même logement
 * sans qu'aucune liste ne puisse plus les rapprocher.
 *
 * ── Pourquoi un modèle dédié et non `CodeNiveau` ──────────────────────────
 * `CodeNiveau` porte un `typeNiveau` qui commande tout son usage (un code de
 * sous-sol n'a rien à faire sous « TOITURE »). Un appartement n'a pas de
 * section : réutiliser la table imposerait une valeur de `typeNiveau` fictive
 * sur chaque ligne, et le premier filtre par section ramènerait des
 * appartements dans la liste des niveaux.
 *
 * ── PORTÉE (`organisationId`) ─────────────────────────────────────────────
 * Même convention que `CodeNiveau`, pour la même raison :
 *   - `null` → catalogue STANDARD de la plateforme (A001 → A015), visible de
 *     toutes les organisations ;
 *   - renseigné → code ajouté par une organisation, visible d'elle seule.
 *
 * Un ajout depuis le mobile reste donc PROPRE à l'organisation qui le crée :
 * pousser l'invention d'un client à ses concurrents ne se rattraperait pas.
 */
const CodeAppartement = sequelize.define('CodeAppartement', {
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
   * Clé stable écrite dans `zones.nom` — « A001 », « A002 ».
   *
   * Le CODE et non l'identifiant, comme pour les autres référentiels : la
   * donnée métier reste lisible, et un export se comprend sans jointure.
   */
  code: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  /**
   * Libellé affiché — « Appartement 001 ».
   *
   * Facultatif : quand l'entreprise crée « B12 » depuis le mobile, elle tape
   * un code, pas une phrase. Le code sert alors de libellé.
   */
  nom: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  /**
   * Rang d'affichage. Le catalogue standard suit la numérotation naturelle
   * (A001 avant A002) ; un ajout se range en fin de liste, faute de position
   * évidente.
   */
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  /**
   * Un code retiré est DÉSACTIVÉ, pas supprimé : les appartements déjà créés
   * gardent le leur, il cesse simplement d'être proposé.
   */
  actif: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  }
}, {
  tableName: 'codes_appartement',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['actif'] }
    // Index d'unicité PARTIELS (standard / par organisation) : Sequelize ne
    // sait pas les décrire ici. Voir la migration 20260909000001.
  ]
});

module.exports = CodeAppartement;
