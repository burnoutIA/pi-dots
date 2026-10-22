# Journal du dot, côté shell : même format que l'extension (une ligne JSON par événement,
# /dot/logs/AAAA-MM-JJ.jsonl). Usage : dot_log <type> ['"clé":valeur,...']
dot_log() {
  local dir="${DOT_HOME:-/dot}/logs"
  mkdir -p "$dir"
  printf '{"t":"%s","role":"environnement","pid":%s,"type":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$$" "$1" "${2:+,$2}" >> "$dir/$(date +%F).jsonl"
}
