'use strict';

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'suivie-chantier-api',
      script: path.join(__dirname, 'src', 'server.js'),

      // Cluster : 1 instance par cœur CPU (Contabo VPS 4 vCPU → 4 workers)
      // Mettre instances: 1 si la DB ne supporte pas bien les connexions parallèles.
      //
      // ⚠ Chaque worker ouvre son PROPRE pool Sequelize : le total de connexions
      // vaut instances × DB_POOL_MAX et doit rester sous max_connections
      // (défaut PostgreSQL : 100). Voir le bloc DB_POOL_MAX de .env.example.
      //
      // Note : sequelize.sync(), seedAdmin() et les 3 tâches cron ne s'exécutent
      // que dans le worker NODE_APP_INSTANCE === '0' (garde `isLeader` dans
      // src/server.js) — sans quoi chaque cron tournait une fois par worker.
      instances: process.env.PM2_INSTANCES || 'max',
      exec_mode: 'cluster',

      // Variables d'env injectées par PM2 (complète le .env déjà chargé par dotenv)
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Audit M11 : en bare-metal derrière nginx, on n'écoute QUE sur le
        // loopback — nginx fait le proxy 443 → 127.0.0.1:3000. En Docker ce
        // HOST est redéfini à 0.0.0.0 dans docker-compose.prod.yml.
        HOST: '127.0.0.1',
      },

      // Logs PM2 (séparés des logs Winston)
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      log_file: path.join(__dirname, 'logs', 'pm2-combined.log'),
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Redémarrage automatique si la RAM dépasse 500 MB
      max_memory_restart: '500M',

      // Délai entre 2 redémarrages automatiques
      restart_delay: 3000,

      // Nombre max de redémarrages avant que PM2 abandonne
      max_restarts: 10,
      min_uptime: '10s',

      // Ne pas surveiller les fichiers (les changements se font via git + pm2 reload)
      watch: false,

      // Arrêt propre : PM2 attend SIGTERM + drain des connexions en cours
      kill_timeout: 10000,
      listen_timeout: 8000,
      shutdown_with_message: false,
    },
  ],
};
