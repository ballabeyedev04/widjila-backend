# ============================================================
#  Suivi Chantier API — Dockerfile multi-stage (production)
#  Stage 1 : deps    → installe uniquement les dépendances de prod
#  Stage 2 : runner  → image finale légère
# ============================================================

# ── Stage 1 : installation des dépendances ───────────────────────────────────
# Image épinglée (audit M8) : toujours mettre à jour explicitement lors d'un
# déploiement. npm ci garde l'audit activé (vérifie les vulns connues).
FROM node:22.20.0-slim AS deps

WORKDIR /app

# Copier les manifestes en premier pour maximiser le cache Docker
COPY package*.json ./

# Dépendances système requises pour les modules natifs (sharp, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Installer uniquement les dépendances de production (audit de sécurité actif)
RUN npm ci --omit=dev --no-fund


# ── Stage 2 : image finale ────────────────────────────────────────────────────
FROM node:22.20.0-slim AS runner

# Dépendances runtime (pas de build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Polices pour génération PDF (pdfkit / puppeteer / html-pdf)
        libfontconfig1 \
        libfreetype6 \
        fonts-liberation \
        fonts-dejavu-core \
        # Sharp / libvips (runtime uniquement)
        libvips \
        # @sparticuz/chromium (puppeteer-core) — libs partagées requises pour lancer Chromium headless
        ca-certificates \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxfixes3 \
        libgbm1 \
        libasound2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-xcb1 \
        # curl pour le HEALTHCHECK
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copier les dépendances de prod depuis le stage deps
COPY --from=deps /app/node_modules ./node_modules

# Copier le code source
COPY --chown=node:node . .

# Créer les répertoires nécessaires avec les bonnes permissions
RUN mkdir -p logs uploads \
    && chown -R node:node /app

# Le bit exécutable est posé ici : un dépôt cloné sous Windows ne le conserve
# pas, et les fins de ligne CRLF empêcheraient le shebang d'être interprété
# (« exec format error » au démarrage du conteneur).
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && chmod +x /app/docker-entrypoint.sh

# Basculer vers l'utilisateur non-root (uid 1000, inclus dans node:slim)
USER node

EXPOSE 3000

# Healthcheck : interroge /health toutes les 30 s
#
# CORRECTIF (le healthcheck mentait) : il ciblait http://localhost:3000, donc la
# loopback DU CONTENEUR. Un process qui n'écoute QUE sur 127.0.0.1 (cas d'un
# HOST=127.0.0.1 hérité du .env) répondait parfaitement à ce test alors qu'il
# était totalement injoignable depuis le réseau bridge — le conteneur était
# marqué "healthy" pendant que nginx recevait « connection refused ».
# On interroge désormais l'adresse du conteneur sur eth0 (celle que Docker
# expose réellement) : un bind sur la mauvaise interface fait échouer le test.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS "http://$(hostname -i | cut -d' ' -f1):3000/health" || exit 1

# L'entrypoint attend la base, applique les migrations, puis exécute le CMD.
# Toute nouvelle migration poussée est donc appliquée automatiquement à chaque
# démarrage de conteneur — aucune commande manuelle après un déploiement.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["node", "src/server.js"]
