#!/bin/sh
# ============================================================================
#  Suivi Chantier API — point d'entrée du conteneur
#
#  Tout ce qui doit être fait AVANT que l'application serve du trafic se passe
#  ici : attendre la base, appliquer les migrations, puis démarrer.
#
#  Pourquoi ici et pas dans le workflow de déploiement :
#    - le workflow ne couvre qu'un seul chemin (push sur main). Un
#      `docker compose restart`, un redémarrage du VPS ou un `docker run`
#      manuel ne passeraient pas par lui ;
#    - le workflow migrait APRÈS `up -d`, donc l'application servait déjà du
#      trafic contre un schéma périmé pendant plusieurs secondes — et restait
#      en ligne si la migration échouait ;
#    - ici, une migration en échec empêche le conteneur de démarrer. Le
#      healthcheck reste rouge, nginx continue de router vers l'ancien
#      conteneur : échec sûr plutôt que corruption silencieuse.
#
#  `set -e` : toute commande en échec interrompt le démarrage.
# ============================================================================
set -e

echo "[entrypoint] Démarrage — $(date '+%Y-%m-%d %H:%M:%S')"

# ── 1. Attendre que PostgreSQL accepte les connexions ────────────────────────
# Docker `depends_on: condition: service_healthy` couvre le cas compose, mais
# pas un `docker run` isolé ni une base distante (base managée, autre hôte).
# On sonde avec le client Sequelize déjà présent : aucun paquet supplémentaire.
ATTENTE_MAX="${DB_WAIT_SECONDS:-60}"
echo "[entrypoint] Attente de PostgreSQL (max ${ATTENTE_MAX}s)…"

i=0
while [ "$i" -lt "$ATTENTE_MAX" ]; do
    if node -e "
        const s = require('/app/src/config/db.js');
        s.authenticate().then(() => process.exit(0)).catch(() => process.exit(1));
    " 2>/dev/null; then
        echo "[entrypoint] PostgreSQL disponible après ${i}s"
        break
    fi
    i=$((i + 1))
    sleep 1
done

if [ "$i" -ge "$ATTENTE_MAX" ]; then
    echo "[entrypoint] ERREUR : PostgreSQL injoignable après ${ATTENTE_MAX}s — abandon." >&2
    exit 1
fi

# ── 2. Appliquer les migrations ──────────────────────────────────────────────
# `db:migrate` est idempotent : sequelize-cli tient le journal des migrations
# déjà jouées dans la table SequelizeMeta et ne rejoue que les nouvelles.
# Relancer un déploiement sans nouvelle migration ne fait donc rien.
# Binaire appelé directement plutôt que via `npx` : le rootfs du conteneur est
# monté en lecture seule (docker-compose.prod.yml), or npx peut vouloir écrire
# dans son cache (~/.npm/_npx) et échouerait.
echo "[entrypoint] Application des migrations…"
if ! ./node_modules/.bin/sequelize-cli db:migrate; then
    echo "" >&2
    echo "[entrypoint] ÉCHEC DES MIGRATIONS — le conteneur ne démarrera pas." >&2
    echo "" >&2
    echo "  Si la base a été créée par sequelize.sync() (tables présentes mais" >&2
    echo "  SequelizeMeta vide), marquez les migrations déjà appliquées :" >&2
    echo "" >&2
    echo "    docker compose -f docker-compose.prod.yml run --rm --entrypoint sh backend \\" >&2
    echo "      -c './node_modules/.bin/sequelize-cli db:migrate:status'" >&2
    echo "" >&2
    exit 1
fi

echo "[entrypoint] Migrations à jour."

# ── 3. Démarrer l'application ────────────────────────────────────────────────
# `exec` remplace le shell par le process Node : celui-ci devient PID 1 et
# reçoit directement SIGTERM, ce qui déclenche l'arrêt propre de server.js
# (fermeture des tâches planifiées puis de la connexion base). Sans `exec`, le
# shell intercepterait le signal et Docker tuerait le conteneur au bout du
# délai de grâce, connexions en cours comprises.
echo "[entrypoint] Lancement : $*"
exec "$@"
