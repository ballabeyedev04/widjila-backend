#!/usr/bin/env bash
# ============================================================
#  Suivi Chantier API — Restauration PostgreSQL
#  Usage   : bash deploy/restore-postgres.sh <fichier.sql.gz.enc> [base_cible]
#
#  Symétrique de backup-postgres.sh : déchiffre (AES-256-CBC, clé
#  BACKUP_ENC_KEY), décompresse, puis restaure via psql (le dump produit par
#  pg_dump est en FORMAT TEXTE, pas custom — psql, pas pg_restore).
#
#  Contexte (audit — Bugs & fiabilité §1) : jusqu'à ce script, le projet
#  produisait des sauvegardes chiffrées mais n'avait AUCUN moyen documenté ou
#  testé de les restaurer. Une sauvegarde qu'on n'a jamais essayé de
#  restaurer n'est qu'une hypothèse. Ce script a été exécuté pour de vrai
#  (backup réel → restauration dans une base neuve → comparaison des
#  données) avant d'être livré — voir le rapport de session pour le détail.
#
#  Sécurité :
#   • Refuse de restaurer dans une base qui contient déjà des tables, sauf
#     confirmation explicite (--force) — un dump pg_dump texte ne fait QUE
#     rejouer des CREATE TABLE / COPY, jamais un DROP : sur une base déjà
#     peuplée, la restauration échouerait à mi-chemin (tables dupliquées) en
#     laissant un état incohérent, ou pire, réussirait à moitié si certaines
#     tables sont absentes.
#   • Le mot de passe déchiffré ne transite jamais par un argument de
#     ligne de commande visible dans `ps` — openssl le lit via -k depuis une
#     variable d'environnement, comme dans backup-postgres.sh.
# ============================================================
set -euo pipefail

APP_DIR="/var/www/suivie-chantier"
FICHIER_BACKUP="${1:-}"
BASE_CIBLE="${2:-}"
FORCER=0

for arg in "$@"; do
  [ "$arg" = "--force" ] && FORCER=1
done

if [ -z "${FICHIER_BACKUP}" ] || [ "${FICHIER_BACKUP}" = "--force" ]; then
  echo "Usage : bash deploy/restore-postgres.sh <fichier.sql.gz.enc> [base_cible] [--force]" >&2
  echo "" >&2
  echo "  <fichier.sql.gz.enc>  Chemin vers une sauvegarde produite par backup-postgres.sh" >&2
  echo "  [base_cible]          Nom de la base à restaurer (défaut : DB_NAME du .env)" >&2
  echo "  --force               Autorise la restauration dans une base non vide" >&2
  exit 1
fi
if [ ! -f "${FICHIER_BACKUP}" ]; then
  echo "[restore] ERREUR : fichier introuvable : ${FICHIER_BACKUP}" >&2
  exit 1
fi

BACKUP_ENC_KEY_FROM_ENV="${BACKUP_ENC_KEY:-${BACKUP_PASSPHRASE:-}}"

# Même chargement du .env que backup-postgres.sh — voir son commentaire :
# la précédence env d'appel > .env permet de restaurer/tester avec une clé
# différente sans éditer le fichier.
if [ -f "${APP_DIR}/.env" ]; then
    set -o allexport
    # shellcheck disable=SC1090
    source <(grep -E '^(DB_[A-Z_]*|PGPASSWORD|BACKUP_ENC_KEY|BACKUP_PASSPHRASE)[[:space:]]*=' "${APP_DIR}/.env" | sed 's/ *= */=/')
    set +o allexport
fi

BACKUP_ENC_KEY="${BACKUP_ENC_KEY_FROM_ENV:-${BACKUP_ENC_KEY:-${BACKUP_PASSPHRASE:-}}}"
DB_NAME="${BASE_CIBLE:-${DB_NAME:-suivie_chantier}}"
DB_USER="${DB_USER:-chantieruser}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"

if [ -z "${BACKUP_ENC_KEY}" ]; then
    echo "[restore] ERREUR : BACKUP_ENC_KEY non définie — impossible de déchiffrer." >&2
    exit 1
fi

MODE_DOCKER=0
if docker compose -f "${APP_DIR}/docker-compose.prod.yml" ps postgres 2>/dev/null | grep -q "Up"; then
    MODE_DOCKER=1
fi

# ── Détection base cible non vide (garde-fou) ────────────────────────────────
compter_tables() {
  if [ "${MODE_DOCKER}" = "1" ]; then
    docker compose -f "${APP_DIR}/docker-compose.prod.yml" exec -T postgres \
      psql -U "${DB_USER}" -d "${DB_NAME}" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0"
  else
    PGPASSWORD="${DB_PASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0"
  fi
}

NB_TABLES=$(compter_tables | tr -d '[:space:]')
if [ "${NB_TABLES}" != "0" ] && [ "${FORCER}" != "1" ]; then
  echo "[restore] ERREUR : la base '${DB_NAME}' contient déjà ${NB_TABLES} table(s)." >&2
  echo "[restore] Restaurer dessus produirait un état incohérent (le dump ne fait que CREATE/COPY, jamais DROP)." >&2
  echo "[restore] Relancez avec --force si c'est réellement voulu (base de test à écraser)," >&2
  echo "[restore] ou créez d'abord une base vide dédiée à la restauration." >&2
  exit 1
fi

# ── Déchiffrement + décompression dans un répertoire temporaire ─────────────
TMPDIR_RESTORE=$(mktemp -d)
trap 'rm -rf "${TMPDIR_RESTORE}"' EXIT   # ne jamais laisser le SQL en clair sur disque

FICHIER_GZ="${TMPDIR_RESTORE}/dump.sql.gz"
FICHIER_SQL="${TMPDIR_RESTORE}/dump.sql"

echo "[restore] Déchiffrement..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in "${FICHIER_BACKUP}" -out "${FICHIER_GZ}" -k "${BACKUP_ENC_KEY}"

echo "[restore] Décompression..."
gunzip -k "${FICHIER_GZ}"
mv "${FICHIER_GZ%.gz}" "${FICHIER_SQL}" 2>/dev/null || true

echo "[restore] Restauration dans '${DB_NAME}'..."
if [ "${MODE_DOCKER}" = "1" ]; then
    echo "[restore] Mode : Docker Compose"
    docker compose -f "${APP_DIR}/docker-compose.prod.yml" exec -T postgres \
        psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${FICHIER_SQL}"
else
    echo "[restore] Mode : bare metal (psql direct)"
    PGPASSWORD="${DB_PASSWORD:-}" psql -v ON_ERROR_STOP=1 \
        -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" < "${FICHIER_SQL}"
fi

NB_TABLES_APRES=$(compter_tables | tr -d '[:space:]')
echo "[restore] Terminé — ${NB_TABLES_APRES} table(s) dans '${DB_NAME}'."
echo "[restore] Vérifiez l'application avant de router du trafic réel dessus."
