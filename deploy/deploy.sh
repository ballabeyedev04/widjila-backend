#!/usr/bin/env bash
# ============================================================
#  Suivi Chantier API — Déploiement zero-downtime (mise à jour)
#  Usage : bash deploy/deploy.sh [--mode docker|pm2]
#  À lancer depuis la racine du projet sur le VPS
# ============================================================
set -euo pipefail

APP_DIR="/var/www/suivie-chantier"
MODE="${DEPLOY_MODE:-docker}"   # docker | pm2

# Parse --mode flag
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode) MODE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

echo "[deploy] Répertoire : ${APP_DIR}"
echo "[deploy] Mode       : ${MODE}"

# 1. Se positionner dans le bon répertoire
cd "${APP_DIR}"

# 2. Vérifier que .env est présent
if [ ! -f ".env" ]; then
    echo "[deploy] ERREUR : fichier .env manquant dans ${APP_DIR}"
    echo "         Copier .env.example vers .env et remplir toutes les valeurs."
    exit 1
fi

# 3. Créer les dossiers nécessaires si absents
mkdir -p logs uploads

# 4. Récupérer les derniers changements
echo "[deploy] git pull..."
git pull --ff-only

if [[ "$MODE" == "docker" ]]; then
    # ── Mode Docker Compose ──────────────────────────────────────────────────
    echo "[deploy] Build et rechargement des conteneurs..."
    docker compose -f docker-compose.prod.yml pull 2>/dev/null || true
    docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

    echo "[deploy] Statut des conteneurs :"
    docker compose -f docker-compose.prod.yml ps

    echo "[deploy] Nettoyage des images inutilisées..."
    docker image prune -f

elif [[ "$MODE" == "pm2" ]]; then
    # ── Mode PM2 ─────────────────────────────────────────────────────────────
    echo "[deploy] npm install..."
    npm install --omit=dev --prefer-offline

    # Migrations AVANT le reload : le nouveau code ne doit jamais servir de
    # trafic contre un schéma périmé. En mode Docker cette étape est prise en
    # charge par l'entrypoint du conteneur ; en bare-metal, c'est ici.
    # `set -e` (en tête de script) interrompt le déploiement si elle échoue,
    # laissant l'ancien process PM2 en ligne — échec sûr.
    echo "[deploy] Application des migrations..."
    ./node_modules/.bin/sequelize-cli db:migrate

    echo "[deploy] pm2 reload (zero-downtime)..."
    pm2 reload ecosystem.config.js --env production --update-env

    echo "[deploy] Statut PM2 :"
    pm2 status suivie-chantier-api

else
    echo "[deploy] ERREUR : mode inconnu '${MODE}'. Utiliser 'docker' ou 'pm2'."
    exit 1
fi

echo ""
echo "[deploy] Déploiement terminé — $(date '+%Y-%m-%d %H:%M:%S')"
