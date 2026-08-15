'use strict';

require('dotenv').config();
const sequelize = require('./config/db.js');
const app = require('./app.js');
const seedAdmin = require('./seeders/adminSeeder.js');
const { startCleanupExpiredTokensJob } = require('./jobs/cleanupExpiredTokens.job.js');
const { startEnRetardJob } = require('./jobs/markReservesEnRetard.job.js');
const { startRemindersJob } = require('./jobs/reminders.job.js');
const { startPurgeDonneesPersonnellesJob } = require('./jobs/purgeDonneesPersonnelles.job.js');
const logger = require('./utils/logger.js');

const isProd = process.env.NODE_ENV === 'production';

// ── Élection du worker « leader » (mode cluster PM2) ──────────────────────────
// CORRECTIF : ecosystem.config.js lance `instances: 'max'` en `exec_mode:
// 'cluster'` (4 workers sur le VPS 4 vCPU). Or sequelize.sync(), seedAdmin() et
// les 3 start*Job() étaient appelés inconditionnellement dans CHAQUE worker :
//   • sync() concurrent au premier boot → CREATE TABLE / ALTER en course ;
//   • seedAdmin() en course → les workers perdants tombaient sur une violation
//     de contrainte d'unicité et faisaient process.exit(1) ;
//   • chaque cron tournait N fois → N notifications identiques par réserve.
// Ces travaux sont désormais réservés à un seul process.
//
// PM2 injecte NODE_APP_INSTANCE = '0', '1', … dans chaque worker du cluster ;
// le worker '0' est notre leader. La variable est ABSENTE en mode fork et en
// exécution directe (`node src/server.js`) : dans ces deux cas il n'y a qu'un
// seul process, il est donc leader de fait. La garde couvre les trois modes.
const instanceId = process.env.NODE_APP_INSTANCE;
const isLeader = instanceId === undefined || instanceId === '' || instanceId === '0';

// Tâches planifiées démarrées par ce process (vide hors leader) — conservées
// pour pouvoir les arrêter proprement avant de fermer la connexion DB.
let tachesPlanifiees = [];

// ── Handlers process non capturées ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
  process.exit(1);
});

let server = null;

async function demarrer() {
  try {
    // ── Base de données ──────────────────────────────────────────────────────
    // Les 23 modèles sont enregistrés sur l'instance sequelize via models/index :
    //  - prod  : sync({ force:false }) crée les tables manquantes sans toucher
    //            l'existant ; les ALTER TABLE passent par les migrations.
    //  - dev   : sync({ alter:true }) applique les modèles localement.
    //            Jamais en production (peut supprimer des colonnes silencieusement).
    //
    // Seul le worker leader synchronise le schéma : les autres se contentent de
    // valider leur connexion (authenticate) — voir la garde `isLeader` plus haut.
    if (!isLeader) {
      await sequelize.authenticate();
      logger.info(`Connexion PostgreSQL établie (worker #${instanceId}, secondaire)`);
    } else if (isProd) {
      // En PRODUCTION, les MIGRATIONS sont la seule source de vérité du schéma.
      // Elles sont appliquées avant le démarrage (docker-entrypoint.sh en Docker,
      // deploy.sh en PM2).
      //
      // `sync({ force:false })` a été retiré : il créait les tables manquantes
      // dans le dos des migrations. Une table ainsi créée n'est pas enregistrée
      // dans SequelizeMeta, si bien que la migration correspondante échoue plus
      // tard sur « relation already exists » — et le schéma diverge en silence
      // du fichier de migration censé le décrire.
      await sequelize.authenticate();
      logger.info('Connexion PostgreSQL établie (schéma géré par les migrations)');
    } else {
      await sequelize.sync({ alter: true });
      logger.info('Connexion PostgreSQL établie et tables synchronisées (développement)');
    }

    if (isLeader) {
      // Admin par défaut (idempotent, mais pas concurrent-safe : leader seul)
      await seedAdmin();

      // ── Tâches planifiées ──────────────────────────────────────────────────
      // Leader seul : sinon chaque tick de cron serait exécuté une fois par
      // worker (N notifications identiques par réserve).
      tachesPlanifiees = [
        startCleanupExpiredTokensJob(),
        startEnRetardJob(),
        startRemindersJob(),
        // Durées de conservation du cahier des charges (journaux 12–36 mois,
        // notifications 12 mois) — sans ce job, la conservation était illimitée.
        startPurgeDonneesPersonnellesJob(),
      ];
    } else {
      logger.info(`Worker #${instanceId} : seed et tâches planifiées ignorés (réservés au worker 0)`);
    }

    // ── Démarrage HTTP ───────────────────────────────────────────────────────
    // HOST : bind par défaut sur toutes les interfaces (requis en Docker).
    // En bare-metal derrière nginx, définir HOST=127.0.0.1 (voir ecosystem.config.js)
    // pour ne pas exposer le port directement (audit M11).
    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HOST || '0.0.0.0';
    server = app.listen(PORT, HOST, () => {
      logger.info(`Serveur lancé sur ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    logger.error('Erreur fatale au démarrage', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ── Arrêt propre (PM2 reload, Docker stop, Ctrl+C) ────────────────────────────
// CORRECTIF (arrêt non idempotent) : SIGTERM puis SIGINT — cas courant, un
// Ctrl+C dans un terminal attaché après un `docker stop`, ou PM2 qui envoie
// SIGINT en filet après SIGTERM — rappelaient server.close() sur un serveur
// déjà fermé, ce qui lève ERR_SERVER_NOT_RUNNING dans le callback. Cette erreur
// non gérée remontait à uncaughtException → process.exit(1) : arrêt en code
// d'erreur, connexions en cours coupées et logs trompeurs.
// CORRECTIF (crons jamais arrêtés) : sequelize.close() était appelé alors que
// les tâches node-cron étaient toujours planifiées ; un tick tombant pendant le
// drain lançait des requêtes sur un pool en fermeture. On arrête donc les
// tâches AVANT de fermer la connexion base.
let arretEnCours = false;

async function arretPropre(signal) {
  // Garde d'idempotence : les signaux suivants sont simplement journalisés.
  if (arretEnCours) {
    logger.info(`${signal} reçu — arrêt déjà en cours, ignoré`);
    return;
  }
  arretEnCours = true;
  logger.info(`${signal} reçu — arrêt propre`);

  // Filet de sécurité : forcer la sortie après 10 s quoi qu'il arrive.
  const filet = setTimeout(() => process.exit(0), 10_000);
  filet.unref();

  try {
    // 1. Ne plus déclencher de nouveaux traitements planifiés.
    //    node-cron 4.x : ScheduledTask.stop() est void | Promise<void>.
    await Promise.all(
      tachesPlanifiees.map(async (tache) => {
        try {
          await tache?.stop?.();
        } catch (err) {
          logger.warn('Échec arrêt d’une tâche planifiée', { error: err.message });
        }
      })
    );
    tachesPlanifiees = [];

    // 2. Cesser d'accepter de nouvelles connexions HTTP et drainer les en-cours.
    if (server && server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }

    // 3. Fermer le pool PostgreSQL une fois plus personne ne l'utilise.
    await sequelize.close();
  } catch (err) {
    logger.error('Erreur pendant l’arrêt propre', { error: err.message });
  } finally {
    clearTimeout(filet);
    process.exit(0);
  }
}

process.on('SIGTERM', () => arretPropre('SIGTERM'));
process.on('SIGINT', () => arretPropre('SIGINT'));

demarrer();
