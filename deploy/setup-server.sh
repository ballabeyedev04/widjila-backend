#!/usr/bin/env bash
# ============================================================
#  Suivi Chantier — Setup initial VPS Contabo Ubuntu 22.04 / 24.04
#  Usage  : sudo bash deploy/setup-server.sh \
#               --api-domain api.example.com --app-domain app.example.com
#  Lancer UNE SEULE FOIS après le premier login root sur le VPS
#
#  Deux domaines séparés (voir deploy/nginx.conf et deploy/nginx-admin.conf) :
#    --api-domain  : sert le backend (API JSON, proxy Node.js)   — obligatoire
#    --app-domain  : sert l'admin (SPA React/Vite statique)      — optionnel
#                    (omettez-le si vous ne déployez pas encore l'admin sur
#                    ce serveur ; relancez le script plus tard pour l'ajouter)
# ============================================================
set -euo pipefail

# ── Paramètres configurables ─────────────────────────────────────────────────
APP_USER="nodeapp"
APP_DIR="/var/www/suivie-chantier"
ADMIN_DIR="/var/www/suivie-chantier-admin"
NODE_VERSION="22"
API_DOMAIN="${API_DOMAIN:-}"
APP_DOMAIN="${APP_DOMAIN:-}"

# Parse flags (--domain reste accepté comme alias historique de --api-domain)
while [[ $# -gt 0 ]]; do
    case "$1" in
        --api-domain) API_DOMAIN="$2"; shift 2 ;;
        --app-domain) APP_DOMAIN="$2"; shift 2 ;;
        --domain)
            echo "AVERTISSEMENT : --domain est un alias déprécié de --api-domain (architecture à deux domaines)."
            API_DOMAIN="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$API_DOMAIN" ]]; then
    echo "ATTENTION : --api-domain non défini. Utilisation :"
    echo "  sudo bash deploy/setup-server.sh --api-domain api.example.com --app-domain app.example.com"
    echo "(--app-domain est optionnel si vous ne déployez pas encore l'admin ici)"
    exit 1
fi

echo "==> [1/10] Mise à jour des paquets"
apt-get update -qq && apt-get upgrade -y -qq

echo "==> [2/10] Installation des dépendances système"
apt-get install -y -qq \
    curl wget git ufw \
    nginx certbot python3-certbot-nginx \
    postgresql postgresql-contrib \
    libfontconfig1 libfreetype6 \
    fonts-liberation fonts-dejavu-core \
    libvips libvips-dev \
    ca-certificates \
    docker.io docker-compose-plugin

echo "==> [3/10] Installation Node.js ${NODE_VERSION} via NodeSource"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
apt-get install -y -qq nodejs

echo "==> [4/10] Installation PM2 globalement"
npm install -g pm2

echo "==> [5/10] Création de l'utilisateur applicatif '${APP_USER}'"
id "${APP_USER}" &>/dev/null || useradd -m -s /bin/bash "${APP_USER}"
usermod -aG docker "${APP_USER}"

echo "==> [6/10] Création de l'arborescence de l'application"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/logs"
mkdir -p "${APP_DIR}/uploads"
mkdir -p "/var/www/certbot"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}"

# Admin (dépôt SÉPARÉ du backend, voir admin/.github/workflows/deploy.yml),
# servi en statique par nginx-admin.conf depuis ${ADMIN_DIR}/dist, sur son
# propre domaine (--app-domain). Créé ici même sans --app-domain pour que le
# premier clonage manuel trouve un répertoire déjà possédé par le bon
# utilisateur, pas /var/www en root.
mkdir -p "${ADMIN_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${ADMIN_DIR}"
chmod 750 "${ADMIN_DIR}"

echo "==> [7/10] Configuration du pare-feu (UFW)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> [8/10] Configuration Nginx"
# Copier le fichier WebSocket map dans conf.d
cp "$(dirname "$0")/nginx-websocket-map.conf" /etc/nginx/conf.d/websocket-map.conf

# ── Site API (obligatoire) ───────────────────────────────────────────────────
cp "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/suivie-chantier-api
sed -i "s/YOUR_DOMAIN/${API_DOMAIN}/g" /etc/nginx/sites-available/suivie-chantier-api
ln -sf /etc/nginx/sites-available/suivie-chantier-api /etc/nginx/sites-enabled/suivie-chantier-api

# ── Site admin (optionnel — seulement si --app-domain fourni) ───────────────
if [[ -n "$APP_DOMAIN" ]]; then
    cp "$(dirname "$0")/nginx-admin.conf" /etc/nginx/sites-available/suivie-chantier-admin
    sed -i "s/YOUR_API_DOMAIN/${API_DOMAIN}/g; s/YOUR_DOMAIN/${APP_DOMAIN}/g" /etc/nginx/sites-available/suivie-chantier-admin
    ln -sf /etc/nginx/sites-available/suivie-chantier-admin /etc/nginx/sites-enabled/suivie-chantier-admin
fi

rm -f /etc/nginx/sites-enabled/default

# Test syntaxe Nginx avant rechargement
nginx -t && systemctl reload nginx

echo "==> [9/10] Obtention des certificats SSL via Certbot"
certbot --nginx \
    -d "${API_DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --email "admin@${API_DOMAIN}" \
    --redirect

if [[ -n "$APP_DOMAIN" ]]; then
    certbot --nginx \
        -d "${APP_DOMAIN}" \
        --non-interactive \
        --agree-tos \
        --email "admin@${API_DOMAIN}" \
        --redirect
fi

echo "==> [10/10] Configuration du renouvellement automatique des certificats"
# Certbot installe un timer systemd automatiquement — vérification :
systemctl status certbot.timer --no-pager || true
# Ajouter une vérification cron en secours
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

echo ""
echo "============================================"
echo " Setup terminé !"
echo "   API   : https://${API_DOMAIN}"
if [[ -n "$APP_DOMAIN" ]]; then
    echo "   Admin : https://${APP_DOMAIN}"
else
    echo "   Admin : non configuré (relancez avec --app-domain plus tard)"
fi
echo ""
echo " Étapes suivantes :"
echo ""
echo " Backend :"
echo "   1. git clone <repo-backend> ${APP_DIR}"
echo "   2. cd ${APP_DIR}"
echo "   3. cp .env.example .env && nano .env   (remplir TOUTES les valeurs, notamment"
echo "      CORS_ORIGIN=https://${APP_DOMAIN:-app.votre-domaine.com} et FRONTEND_URL de même)"
echo ""
echo "   Option A — Docker Compose (recommandé) :"
echo "     4. docker compose -f docker-compose.prod.yml up -d --build"
echo "     5. docker compose -f docker-compose.prod.yml logs -f backend"
echo ""
echo "   Option B — PM2 direct :"
echo "     4. npm install --omit=dev"
echo "     5. npm run pm2:start"
echo "     6. pm2 save && pm2 startup (suivre les instructions)"
echo ""
echo " Admin (dépôt séparé) :"
echo "   7. git clone <repo-admin> ${ADMIN_DIR}"
echo "   8. cd ${ADMIN_DIR} && cp .env.example .env && nano .env   (VITE_API_BASE_URL="
echo "      https://${API_DOMAIN}/api/v1 — URL ABSOLUE, cross-origin avec l'admin)"
echo "   9. npm ci && npm run build   (dist/ est déjà la racine servie par nginx-admin.conf)"
echo "  10. Configurer les secrets GitHub du dépôt admin (VPS_HOST/VPS_USER/VPS_SSH_KEY)"
echo "      pour que admin/.github/workflows/deploy.yml puisse déployer ensuite tout seul."
if [[ -z "$APP_DOMAIN" ]]; then
    echo ""
    echo "   ATTENTION : --app-domain n'a pas été fourni — relancez ce script avec"
    echo "   --api-domain ${API_DOMAIN} --app-domain app.votre-domaine.com avant l'étape 7."
fi
echo "============================================"
