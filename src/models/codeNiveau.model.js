'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { TYPE_NIVEAU } = require('../config/enums.js');

/**
 * Référentiel des CODES DE NIVEAU — « SS1 », « RDC », « R+1 », « TOIT »…
 *
 * ── Pourquoi un référentiel et non une liste figée ────────────────────────
 * L'entreprise qui dépose ses plans choisit le code du niveau dans une liste.
 * Aucune liste écrite à l'avance ne peut convenir : un immeuble de bureaux
 * s'arrête à R+8, une tour va à R+40, et certains chantiers numérotent leurs
 * sous-sols au-delà de SS3. Le client a explicitement demandé qu'un code
 * absent puisse être créé depuis le mobile, et qu'il soit ensuite proposé aux
 * suivants.
 *
 * ── Pourquoi un modèle dédié plutôt que la fabrique ───────────────────────
 * `definirReferentielType` couvre les référentiels à plat. Celui-ci porte en
 * plus un `typeNiveau` : « SS1 » n'a de sens que pour un sous-sol, « R+1 »
 * que pour un étage. Sans cette colonne, la liste proposée sous « SOUS-SOLS »
 * mélangerait les codes de toiture — exactement ce que les trois sections de
 * l'écran servent à éviter.
 *
 * ── PORTÉE (`organisationId`) ─────────────────────────────────────────────
 * Même convention que les autres référentiels :
 *   - `null` → catalogue STANDARD de la plateforme, visible de toutes les
 *     organisations ;
 *   - renseigné → code créé par une organisation, visible d'elle seule.
 *
 * Le client a répondu « par tout le monde » à la question du partage des
 * codes : les codes standards couvrent donc les cas courants, et un ajout
 * depuis le mobile reste PROPRE à l'organisation qui le crée — partager
 * l'invention d'un client avec ses concurrents ne se rattraperait pas.
 */
const CodeNiveau = sequelize.define('CodeNiveau', {
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
   * Section à laquelle ce code appartient — `sous_sol`, `etage` ou `toiture`.
   * C'est lui qui range le code sous la bonne section de l'écran mobile.
   */
  typeNiveau: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [TYPE_NIVEAU] }
  },
  /**
   * Clé stable écrite dans `etages.code_niveau` — « SS1 », « RDC », « R+1 ».
   *
   * Le CODE et non l'identifiant, comme pour les autres référentiels : la
   * donnée métier reste lisible, et un export ou un journal se comprend sans
   * jointure.
   */
  code: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  /**
   * Libellé affiché — « Sous-sol 1 », « Rez-de-chaussée ».
   *
   * Facultatif : quand l'entreprise crée « SS4 » depuis le mobile, elle tape
   * un code, pas une phrase. Le code sert alors de libellé.
   */
  nom: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  /**
   * Rang d'affichage. Les niveaux se lisent dans un ordre PHYSIQUE — SS2 sous
   * SS1, R+2 au-dessus de R+1 — que l'ordre alphabétique ne rend pas :
   * « R+10 » se placerait entre « R+1 » et « R+2 ».
   */
  ordre: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  /**
   * Un code retiré est DÉSACTIVÉ, pas supprimé : les étages déjà créés
   * gardent le leur, il cesse simplement d'être proposé.
   */
  actif: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  }
}, {
  tableName: 'codes_niveau',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['type_niveau'] },
    { fields: ['actif'] }
    // Index d'unicité PARTIELS (standard / par organisation) : Sequelize ne
    // sait pas les décrire ici. Voir la migration 20260902000001.
  ]
});

module.exports = CodeNiveau;
