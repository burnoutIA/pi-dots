#!/usr/bin/env bash
# Le pi de la conversation, relancé s'il s'arrête. Chaque arrêt est noté dans le journal du dot,
# avec son code de sortie (137 = tué, souvent faute de mémoire).
source /opt/dot/log.sh

while true; do
  started=$(date +%s)
  pi --continue
  code=$?
  dot_log "pi.exit" "\"code\":$code,\"uptimeS\":$(( $(date +%s) - started ))"
  echo "pi s'est arrêté (code $code), relance dans 3 s"
  sleep 3
done
