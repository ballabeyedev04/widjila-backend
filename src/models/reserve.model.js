const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Réserve — la table centrale du produit (voir cahier des charges, module 5).
 * Cycle de vie : creee → affectee → (prise_en_charge) → en_cours → corrigee →
 *               a_verifier → validee / refusee → (rouverte) → cloturee.
 * `prise_en_charge` : le sous-traitant accuse réception de la réserve avant
 * de démarrer — étape optionnelle, `affectee → en_cours` reste légal pour les
 * autres rôles qui ne l'utilisent pas.
 *
 * Règles métier importantes :
 *   - une réserve ne peut être validée qu'avec des preuves de correction ;
 *   - une réserve validée ne peut pas être supprimée ;
 *   - toute modification est tracée dans reserve_historiques ;
 *   - une réserve est liée à une position (x, y) sur un plan.
 */
const Reserve = sequelize.define('Reserve', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  // Numéro automatique (R-0001) — attribué par le service au moment de la
  // création. La numérotation repart à 1 sur CHAQUE chantier : l'unicité doit
  // donc être composite (chantier_id, numero) et non globale, sinon le second
  // chantier ne peut jamais créer sa première réserve.
  // Voir l'index unique déclaré plus bas.
  numero: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  // Numéro PROPRE AU PLAN (1, 2, 3…) — attribué par le service à la création
  // quand la réserve est posée sur un plan, nul sinon. C'est lui que le plan
  // affiche sur chaque repère : `R-0031` ne dit pas à l'utilisateur laquelle
  // des réserves de CE plan a été relevée en premier, « 3 » oui.
  // Jamais réattribué (les lignes supprimées restent dans l'index unique), et
  // jamais modifié par un changement de statut ou de contenu : il n'est
  // recalculé que si la réserve change de plan. Voir l'index partiel plus bas.
  numeroPlan: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  chantierId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  batimentId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  etageId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  zoneId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  planId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  lotId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  titre: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  severite: {
    type: DataTypes.ENUM('faible', 'moyenne', 'haute', 'critique'),
    allowNull: false,
    defaultValue: 'moyenne'
  },
  priorite: {
    type: DataTypes.ENUM('faible', 'moyenne', 'haute', 'critique'),
    allowNull: false,
    defaultValue: 'moyenne'
  },
  /**
   * Phase du chantier au cours de laquelle la réserve a été constatée.
   *
   * OBLIGATOIRE à la création (imposé par `creerReserveSchema`), et FIGÉE
   * ensuite : une réserve relevée en « Pré-cloisons » y reste quand le
   * chantier passe en « Cloisons ». C'est ce qui rend l'historique par phase
   * exploitable.
   *
   * Nullable en base pour les réserves antérieures à cette règle — leur
   * attribuer une phase au hasard fabriquerait un historique faux. Voir la
   * migration 20260829000008-reserve-phase.js.
   */
  phaseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /**
   * Corps d'état (métier) de la réserve — référence au catalogue
   * administrable `corps_etat`.
   *
   * Remplace fonctionnellement `categorie` juste en dessous, conservée pour
   * les clients non mis à jour et pour l'export Excel. Quand les deux sont
   * présents, `corpsEtatId` fait foi.
   */
  corpsEtatId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Catégorie de la réserve (module 5 / cahier des charges § Catégorie)
  // ⚠️ Historique : voir `corpsEtatId` ci-dessus, qui la remplace.
  categorie: {
    type: DataTypes.ENUM('maconnerie', 'gros_oeuvre', 'plomberie', 'electricite', 'carrelage', 'peinture', 'menuiserie', 'etancheite', 'isolation', 'autre'),
    allowNull: true,
    defaultValue: 'autre'
  },
  statut: {
    type: DataTypes.ENUM('creee', 'affectee', 'prise_en_charge', 'en_cours', 'a_surveiller', 'a_echeance', 'corrigee', 'traitee', 'a_verifier', 'validee', 'levee', 'refusee', 'rouverte', 'en_retard', 'cloturee'),
    allowNull: false,
    defaultValue: 'creee'
  },
  // Entreprise (ORGANISATION, avec son propre compte) en charge de la
  // correction — utilisée quand le sous-traitant travaille lui aussi dans
  // l'application et doit voir la réserve dans SON espace.
  entrepriseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Entreprise / corps d'état de l'ANNUAIRE du chantier (table `partenaires`).
  //
  // C'est le champ « Entreprise concernée » du guide client : la plupart des
  // entreprises d'un chantier sont de simples fiches de contact, sans compte
  // dans l'application, et ne peuvent donc pas être désignées par
  // `entrepriseId` — qui référence une `organisation`.
  //
  // Les deux coexistent volontairement : `partenaireId` dit QUI est
  // responsable (toujours renseignable), `entrepriseId` dit à quel espace
  // client la réserve doit apparaître (seulement si l'entreprise est
  // utilisatrice de la plateforme).
  partenaireId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  // Utilisateur auquel la réserve est affectée
  assigneA: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_limite: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  creePar: {
    type: DataTypes.UUID,
    allowNull: false
  },
  validePar: {
    type: DataTypes.UUID,
    allowNull: true
  },
  date_validation: {
    type: DataTypes.DATE,
    allowNull: true
  },
  motif_refus: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'reserves',
  timestamps: true,
  paranoid: true,
  underscored: true,
  indexes: [
    { fields: ['chantier_id'] },
    { fields: ['statut'] },
    { fields: ['entreprise_id'] },
    { fields: ['partenaire_id'] },
    { fields: ['assigne_a'] },
    { fields: ['corps_etat_id'] },
    { fields: ['phase_id'] },
    // Un numéro est unique DANS son chantier, pas dans toute la base.
    { name: 'reserves_chantier_numero_unique', unique: true, fields: ['chantier_id', 'numero'] },
    // Un numéro de plan est unique DANS son plan. Partiel : les réserves sans
    // plan n'y entrent pas.
    {
      name: 'reserves_plan_numero_plan_unique',
      unique: true,
      fields: ['plan_id', 'numero_plan'],
      where: { plan_id: { [Op.ne]: null }, numero_plan: { [Op.ne]: null } }
    }
  ]
});

module.exports = Reserve;
