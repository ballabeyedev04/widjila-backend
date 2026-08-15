#!/usr/bin/env bash
# ============================================================
#  Suivi Chantier API — Sauvegarde PostgreSQL
#  Usage   : bash deploy/backup-postgres.sh
#  Cron    : 0 2 * * * /var/www/suivie-chantier/deploy/backup-postgres.sh >> /var/log/suivie-chantier-backup.log 2>&1
#
#  Fonctionnement :
#   • Docker Compose → pg_dump via le conteneur postgres
#   • PM2 / bare metal → pg_dump direct (postgres doit être installé sur l'hôte)
#   • Compresse le dump en .gz PUIS le chiffre (AES-256-CBC, clé BACKUP_ENC_KEY)
#   • Permissions 700/600 (pas de backup lisible par tous — audit M7)
#   • Garde les 7 dernières sauvegardes (purge automatique)
# ============================================================
set -euo pipefail

APP_DIR="/var/www/suivie-chantier"
BACKUP_DIR="${APP_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DUMP="${BACKUP_DIR}/suivie_chantier_${TIMESTAMP}.sql.gz"
BACKUP_FILE="${BACKUP_DUMP}.enc"
KEEP_DAYS=7

# ── Clé de chiffrement des backups (32 octets hex — obligatoire) ─────────────
# Générez-la une fois et ajoutez-la au .env :
#   openssl rand -hex 32
#
# CORRECTIF (sauvegarde quotidienne cassée depuis toujours) :
# la clé était lue ICI, AVANT le chargement du .env, et le motif grep de ce
# chargement ne récupérait que '^(DB_|PGPASSWORD)'. BACKUP_ENC_KEY n'était donc
# jamais importée du .env. Lancé par cron — dont l'environnement est minimal
# (PATH/HOME/SHELL uniquement, aucun export du shell de login) — la variable
# restait vide et le script sortait en erreur au contrôle plus bas : AUCUN dump
# n'a jamais été produit. Fonctionnait uniquement en lancement manuel depuis un
# shell où la variable avait été exportée à la main.
#
# On mémorise d'abord la valeur éventuellement présente dans l'environnement
# d'appel (run manuel ponctuel), car le `source` ci-dessous — exécuté avec
# allexport — écrase les variables déjà définies.
BACKUP_ENC_KEY_FROM_ENV="${BACKUP_ENC_KEY:-${BACKUP_PASSPHRASE:-}}"

# ── Charger les variables d'environnement depuis .env ────────────────────────
# Motif élargi : DB_* (DB_NAME/USER/HOST/PORT/PASSWORD), PGPASSWORD, et les deux
# noms acceptés pour la clé de chiffrement. L'ancre '=' évite d'attraper des
# lignes de commentaire commençant par le même préfixe.
# Vérifié : ce sont les SEULES variables d'environnement consommées par ce
# script (APP_DIR, BACKUP_DIR, KEEP_DAYS, GDRIVE_FOLDER sont codés en dur).
if [ -f "${APP_DIR}/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1090
    source <(grep -E '^(DB_[A-Z_]*|PGPASSWORD|BACKUP_ENC_KEY|BACKUP_PASSPHRASE)[[:space:]]*=' "${APP_DIR}/.env" | sed 's/ *= */=/')
    set +o allexport
fi

# Précédence : environnement d'appel > .env (permet de surcharger ponctuellement
# la clé pour restaurer/tester sans éditer le .env).
BACKUP_ENC_KEY="${BACKUP_ENC_KEY_FROM_ENV:-${BACKUP_ENC_KEY:-${BACKUP_PASSPHRASE:-}}}"

DB_NAME="${DB_NAME:-suivie_chantier}"
DB_USER="${DB_USER:-chantieruser}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

if [ -z "${BACKUP_ENC_KEY}" ]; then
    echo "[backup] ERREUR : BACKUP_ENC_KEY non définie — sauvegarde ANNULÉE (les backups ne doivent jamais être en clair)." >&2
    echo "[backup] Ajoutez 'BACKUP_ENC_KEY=<openssl rand -hex 32>' dans ${APP_DIR}/.env" >&2
    exit 1
fi

echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') — Début sauvegarde de '${DB_NAME}'"

# Détecter le mode (Docker ou bare metal)
if docker compose -f "${APP_DIR}/docker-compose.prod.yml" ps postgres 2>/dev/null | grep -q "Up"; then
    echo "[backup] Mode : Docker Compose"
    docker compose -f "${APP_DIR}/docker-compose.prod.yml" exec -T postgres \
        pg_dump -U "${DB_USER}" "${DB_NAME}" \
        | gzip > "${BACKUP_DUMP}"
else
    echo "[backup] Mode : bare metal (pg_dump direct)"
    PGPASSWORD="${DB_PASSWORD:-}" pg_dump \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        "${DB_NAME}" \
        | gzip > "${BACKUP_DUMP}"
fi

# Chiffrement AES-256-CBC (défensif même si l'os du VPS est compromis)
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
    -in "${BACKUP_DUMP}" -out "${BACKUP_FILE}" -k "${BACKUP_ENC_KEY}"
rm -f "${BACKUP_DUMP}"           # ne jamais garder le dump en clair
chmod 600 "${BACKUP_FILE}"       # lisible uniquement par l'utilisateur du script

SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
echo "[backup] Sauvegarde chiffrée créée : ${BACKUP_FILE} (${SIZE})"

# Upload vers Google Drive (si rclone est installé)
RCLONE_BIN=$(command -v rclone || echo "/usr/bin/rclone")
GDRIVE_FOLDER="gdrive:suivie-chantier-backups"
if [ -x "${RCLONE_BIN}" ]; then
    echo "[backup] Upload vers Google Drive..."
    "${RCLONE_BIN}" copy "${BACKUP_FILE}" "${GDRIVE_FOLDER}"
    echo "[backup] Upload terminé → ${GDRIVE_FOLDER}"
else
    echo "[backup] rclone introuvable — upload Drive ignoré"
fi

# Purger les sauvegardes chiffrées de plus de KEEP_DAYS jours (local)
find "${BACKUP_DIR}" -name "suivie_chantier_*.sql.gz.enc" -mtime "+${KEEP_DAYS}" -delete
REMAINING=$(find "${BACKUP_DIR}" -name "suivie_chantier_*.sql.gz.enc" | wc -l)
echo "[backup] Sauvegardes locales conservées : ${REMAINING}"

echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') — Terminé"
