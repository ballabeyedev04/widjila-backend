const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * JobExecution — historique des exécutions des tâches planifiées.
 *
 * Les jobs (retards, rappels, purge RGPD, nettoyage des jetons) ne laissaient
 * AUCUNE trace hors des journaux texte : impossible de répondre à « la purge
 * a-t-elle tourné dimanche ? », « depuis quand le marquage des retards
 * échoue-t-il ? », « le serveur a-t-il redémarré au milieu d'une exécution ? ».
 *
 * Une ligne par exécution, écrite par `utils/executerJob.js` :
 *   - `en_cours` à l'entrée, puis `succes` / `echec` à la sortie ;
 *   - une ligne restée `en_cours` au démarrage suivant passe `interrompu` :
 *     le process est mort pendant l'exécution — c'est visible, pas silencieux ;
 *   - `tentative` numérote les reprises automatiques d'un même passage.
 *
 * `statut` en texte contrôlé (et non ENUM PostgreSQL) : ajouter un état ne
 * doit pas exiger un ALTER TYPE.
 */
const STATUTS = ['en_cours', 'succes', 'echec', 'interrompu'];

const JobExecution = sequelize.define('JobExecution', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  job: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  statut: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'en_cours',
    validate: { isIn: [STATUTS] },
  },
  tentative: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  debut: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  fin: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  duree_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // Message de la dernière erreur (tronqué) — la pile complète est dans les
  // journaux, retrouvable par l'identifiant d'exécution.
  erreur: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Bilan renvoyé par le job (nombre de lignes traitées…).
  resultat: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  // Hôte et worker PM2 — pour savoir QUEL process a exécuté (ou perdu) le job.
  instance: {
    type: DataTypes.STRING(120),
    allowNull: true,
  },
}, {
  tableName: 'job_executions',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['job', 'debut'] },
    { fields: ['statut'] },
  ],
});

JobExecution.STATUTS = STATUTS;

module.exports = JobExecution;
