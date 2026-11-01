#!/usr/bin/env bash
# Le pi de la conversation, relancé s'il s'arrête. Chaque arrêt est noté dans le journal du dot,
# avec son code de sortie (137 = tué, souvent faute de mémoire).
source /opt/dot/log.sh

# La conversation reprend sa dernière session. Pas `pi --continue` : il reprend la session la plus
# récente du dossier, souvent celle d'un run autonome (ids en dot-…), et la conversation travaillerait
# alors dans le fil du run, en même temps que lui.
SESSIONS="${PI_CODING_AGENT_DIR:-/dot/agent}/sessions/--dot-workspace--"

while true; do
  started=$(date +%s)
  session="$(ls -t "$SESSIONS"/*.jsonl 2>/dev/null | grep -v '_dot-[^/]*\.jsonl$' | head -1)"
  pi $DOT_PI_EXTENSIONS ${session:+--session "$session"}
  code=$?
  dot_log "pi.exit" "\"code\":$code,\"uptimeS\":$(( $(date +%s) - started ))"
  echo "pi s'est arrêté (code $code), relance dans 3 s"
  sleep 3
done
