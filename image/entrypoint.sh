#!/usr/bin/env bash
# Démarrage du dot : prépare son dossier persistant, écrit la configuration de pi à partir des
# variables de l'utilisateur, puis lance pi dans tmux en reprenant la dernière conversation.
set -euo pipefail
source /opt/dot/log.sh

: "${DOT_HOME:=/dot}"
: "${PI_CODING_AGENT_DIR:=$DOT_HOME/agent}"
AGENT="$PI_CODING_AGENT_DIR"

mkdir -p "$AGENT/extensions" "$DOT_HOME"/{memory,inbox,workspace,browser,logs}
dot_log "environment.start"

# Fichiers fournis par le dépôt : remplacés à chaque démarrage (une mise à jour de l'image s'applique).
cp /opt/dot/defaults/APPEND_SYSTEM.md "$AGENT/APPEND_SYSTEM.md"
cp /opt/dot/defaults/mcp.json "$AGENT/mcp.json"
for ext in /opt/dot/extensions/*/ /opt/dot-vendor/extensions/*/; do
  name="$(basename "$ext")"
  rm -rf "$AGENT/extensions/$name"
  cp -r "$ext" "$AGENT/extensions/$name"
done

# Fichiers de mémoire : créés une fois, ensuite ils appartiennent au dot.
for file in MEMORY.md JOURNAL.md; do
  [ -e "$DOT_HOME/memory/$file" ] || cp "/opt/dot/defaults/memory/$file" "$DOT_HOME/memory/$file"
done

# Providers déclarés par l'utilisateur (endpoints compatibles, serveurs locaux…).
if [ -f /opt/dot/config/models.json ]; then
  cp /opt/dot/config/models.json "$AGENT/models.json"
fi

# Réglages de pi : le modèle vient des variables, le reste de ce que pi a déjà écrit est gardé.
node - "$AGENT/settings.json" <<'EOF'
const fs = require("node:fs");
const file = process.argv[2];
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const env = process.env;
if (env.DOT_PROVIDER) settings.defaultProvider = env.DOT_PROVIDER;
if (env.DOT_MODEL) settings.defaultModel = env.DOT_MODEL;
if (env.DOT_THINKING) settings.defaultThinkingLevel = env.DOT_THINKING;
settings.quietStartup ??= "header";
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
EOF

# pi tourne dans tmux (on peut s'y rattacher avec `./dot attach`) et reprend sa dernière
# conversation ; s'il s'arrête, il est relancé. Le conteneur vit tant que tmux vit.
cd "$DOT_HOME/workspace"
tmux new-session -d -s dot -x 200 -y 50 /opt/dot/run-pi.sh

stop() {
  dot_log "environment.stop"
  tmux kill-server 2>/dev/null || true
  exit 0
}
trap stop TERM INT

echo "dot démarré ($(date -Is)). Se rattacher : ./dot attach"
while tmux has-session -t dot 2>/dev/null; do
  sleep 5 &
  wait $!
done
