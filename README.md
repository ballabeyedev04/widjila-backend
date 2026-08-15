# Suivi Chantier API

Backend Node.js/Express + Sequelize (PostgreSQL). Squelette initial créé en
suivant l'architecture du projet de référence **sign-api** (`apk_sign/backend-app`).

## Architecture

```
├── deploy/                  # Scripts de déploiement VPS (Nginx, backup, setup)
├── scripts/                 # Scripts utilitaires (grant-superadmin)
├── src/
│   ├── app.js               # Configuration Express (middlewares, routes, health)
│   ├── server.js            # Point d'entrée (DB sync, seed admin, listen)
│   ├── config/              # db.js, security.js, sequelize.config.js
│   ├── controllers/         # Contrôleurs (admin/, particulier/, professionnel/)
│   ├── errors/              # AppError et erreurs métier
│   ├── jobs/                # Tâches planifiées (node-cron)
│   ├── middlewares/         # auth, errorHandler, asyncHandler…
│   ├── migrations/          # Migrations Sequelize CLI
│   ├── models/              # Modèles Sequelize (+ index.js pour les associations)
│   ├── routes/              # Routes Express (admin/, particulier/, professionnel/)
│   ├── scripts/             # seedAdmin…
│   ├── seeders/             # adminSeeder
│   ├── services/            # Logique métier (admin/, particulier/, professionnel/)
│   ├── templates/           # mail/ et pdf/
│   ├── utils/               # logger, response, paginate…
│   └── validations/         # Schémas Joi
├── .github/workflows/       # CI/CD — déploiement auto vers le VPS
├── Dockerfile               # Image multi-stage (production)
├── docker-compose.yml       # Dev (postgres + backend, hot-reload)
├── docker-compose.prod.yml  # Prod (Nginx → 127.0.0.1:3000)
└── ecosystem.config.js      # PM2 (cluster)
```

**Pattern** : `route → controller → service → model`, réponses uniformes
`{ success, message, data }`, erreurs via `AppError` + `errorHandler`.

## Démarrage rapide (dev)

1. `npm install`
2. Créer la base PostgreSQL :
   `psql -U postgres -c "CREATE USER chantieruser WITH PASSWORD 'chantierpassword' CREATEDB; CREATE DATABASE suivie_chantier OWNER chantieruser;"`
   (ou `docker compose up --build` pour un Postgres isolé — **attention** : le
   port 5432 ne doit pas être déjà occupé par un autre Postgres).
3. `npm run dev` → http://localhost:3000/health

Routes de démo : `POST /api/v1/auth/register`, `POST /api/v1/auth/login`.

## Production (VPS Ubuntu)

1. `sudo bash deploy/setup-server.sh --domain api.votre-domaine.com` (1 fois)
2. `git clone <repo> /var/www/suivie-chantier`
3. `cp .env.example .env` puis remplir toutes les valeurs
4. **Option A — Docker** : `npm run docker:prod`
5. **Option B — PM2** : `npm install --omit=dev && npm run pm2:start`

**CI/CD** : pousser sur `main` déclenche `.github/workflows/deploy.yml`
(SSH → `git pull --rebase` → rebuild backend → migrations → healthcheck).
Ajouter les secrets GitHub : `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.

**Sauvegardes** : `npm run backup` (pg_dump → `.gz` → Google Drive via rclone).

## Notes

- Ce squelette ne contient **pas** le code métier de la référence (contrats,
  factures, PDF…) — seuls les patterns et les fichiers de config/déploiement.
- `src/models/index.js` est le point d'ancrage des associations : ajoutez-y
  chaque nouveau modèle.
- Les dépendances lourdes de la référence (PDF, R2, Firebase, Twilio…) ont été
  retirées de `package.json` ; ré-ajoutez-les quand le besoin se présente.
