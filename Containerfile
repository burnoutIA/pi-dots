# L'environnement clos d'un dot : l'OS, les outils et pi, préinstallés.
# Construit par `./dot build` (docker ou podman).

FROM node:24-bookworm-slim

ARG PI_VERSION=1.3.0
ARG KETCH_VERSION=0.19.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.83

# --- OS et outils de base -----------------------------------------------------
# sudo sans mot de passe : dans son environnement, le dot est chez lui (il installe ce qu'il veut).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less nano procps python3 python3-pip python3-venv \
      ripgrep fd-find sudo tini tmux tzdata unzip wget \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
 && echo 'Defaults env_keep += "http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY"' > /etc/sudoers.d/proxy \
 && rm -rf /var/lib/apt/lists/*

# --- ketch : recherche web et lecture de pages, sans clé API ------------------
RUN set -eux; \
    archive="ketch_${KETCH_VERSION}_linux_x86_64.tar.gz"; \
    base="https://github.com/1broseidon/ketch/releases/download/v${KETCH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/$archive"; \
    curl -fsSLO "$base/checksums.txt"; \
    grep " $archive\$" checksums.txt | sha256sum -c -; \
    tar -xzf "$archive" -C /usr/local/bin ketch; \
    rm -f "$archive" checksums.txt; \
    ketch version

# --- pi et le navigateur (Playwright, piloté par MCP) -------------------------
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g --ignore-scripts \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && cd "$(npm root -g)/@playwright/mcp" \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /opt/ms-playwright \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

# --- Extensions pi tierces, figées sur un commit ------------------------------
# ctx-optimizer : allège le contexte (vieux résultats d'outils distillés, raisonnement passé retiré)
# pour que l'agent travaille au lieu de compacter.
ARG CTX_OPTIMIZER_COMMIT=976308050729bc0d8aa81e97ddd8eb42832eae59
RUN set -eux; \
    mkdir -p /opt/dot-vendor/extensions; \
    curl -fsSL "https://codeload.github.com/burnoutIA/ctx_optimizer/tar.gz/${CTX_OPTIMIZER_COMMIT}" \
      | tar -xz -C /tmp; \
    mv "/tmp/ctx_optimizer-${CTX_OPTIMIZER_COMMIT}/pi/ctx-optimizer" /opt/dot-vendor/extensions/ctx-optimizer; \
    rm -rf "/tmp/ctx_optimizer-${CTX_OPTIMIZER_COMMIT}"

# --- Ce que le dépôt apporte : consignes, extensions, démarrage ---------------
COPY image/ /opt/dot/
# Le coffre (dot-vault) tourne depuis la même image : node /opt/dot/vault/vault.mjs
RUN chmod +x /opt/dot/entrypoint.sh /opt/dot/run-pi.sh \
 && printf 'set -g extended-keys on\nset -g history-limit 50000\n' > /home/node/.tmux.conf \
 && chown node:node /home/node/.tmux.conf

# La version de pi est fixée par l'image : pas de vérification de mise à jour au démarrage.
ENV DOT_HOME=/dot \
    PI_CODING_AGENT_DIR=/dot/agent \
    PI_SKIP_VERSION_CHECK=1 \
    HOME=/home/node

USER node
WORKDIR /dot/workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dot/entrypoint.sh"]
