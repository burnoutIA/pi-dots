#!/usr/bin/env python3
"""Le veilleur : allumer et éteindre le dot à distance, depuis Telegram.

Il tourne sur la machine, hors du dot (service de session : ./dot veilleur install).
  - Dot éteint : il écoute Telegram à sa place. /allumer lance ./dot start ; tout autre message
    reçoit « je suis éteint ».
  - Dot allumé : il n'écoute pas Telegram (un bot n'a qu'un lecteur : c'est le dot). Il surveille
    seulement la demande d'extinction que le dot lui transmet (/eteindre) et lance ./dot stop.
Il signale qu'il est vivant dans state/channel/veilleur.json, et note ce qu'il fait au journal.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANNEL = ROOT / "state" / "channel"
POWER = CHANNEL / "power.json"
ALIVE = CHANNEL / "veilleur.json"
LOGS = ROOT / "state" / "logs"
ENGINE = os.environ.get("DOT_ENGINE_BIN", "podman")


def log(kind: str, **data):
    LOGS.mkdir(parents=True, exist_ok=True)
    line = {"t": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "role": "veilleur", "type": kind, **data}
    with (LOGS / f"{datetime.now():%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")


def setting(name: str) -> str:
    try:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except FileNotFoundError:
        pass
    return ""


def token() -> str:
    try:
        return json.loads((ROOT / "config" / "vault.json").read_text())["secrets"]["TELEGRAM_TOKEN"]["value"]
    except Exception:
        return ""


def telegram(method: str, params: dict, timeout: int = 30):
    url = f"https://api.telegram.org/bot{token()}/{method}"
    req = urllib.request.Request(url, data=json.dumps(params).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r).get("result")


STATE = ROOT / "state" / "memory" / "state.json"


def engine_says_running() -> bool:
    out = subprocess.run([ENGINE, "inspect", "-f", "{{.State.Running}}", "dot"], capture_output=True, text=True)
    return out.stdout.strip() == "true"


def running() -> bool:
    """Le dot écrit un signe de vie toutes les 15 s : le lire ne coûte rien, contrairement à lancer
    podman. On ne demande au moteur qu'en cas de doute (signe de vie ancien)."""
    try:
        alive = json.loads(STATE.read_text()).get("lastAlive")
        if alive and time.time() - datetime.fromisoformat(alive.replace("Z", "+00:00")).timestamp() < 60:
            return True
    except Exception:
        pass
    return engine_says_running()


def dot(action: str):
    subprocess.run([str(ROOT / "dot"), action], capture_output=True)


def main():
    owner = int(setting("TELEGRAM_OWNER_ID") or 0)
    if not token() or not owner:
        sys.exit("Veilleur : Telegram n'est pas configuré (TELEGRAM_TOKEN dans config/vault.json, TELEGRAM_OWNER_ID dans .env).")
    log("watcher.start")
    offset = 0
    while True:
        CHANNEL.mkdir(parents=True, exist_ok=True)
        ALIVE.write_text(json.dumps({"t": datetime.now(timezone.utc).isoformat()}))

        # Le dot demande à être éteint (/eteindre sur Telegram).
        if POWER.exists():
            try:
                action = json.loads(POWER.read_text()).get("action")
            except Exception:
                action = None
            POWER.unlink(missing_ok=True)
            if action == "stop" and running():
                dot("stop")
                log("watcher.stop")
                try:
                    telegram("sendMessage", {"chat_id": owner, "text": "Dot éteint. /allumer pour le relancer."})
                except Exception:
                    pass

        if running():
            offset = 0  # le dot lit lui-même ses messages ; on reprendra à sa suite
            time.sleep(10)
            continue

        # Dot éteint : le veilleur écoute Telegram à sa place.
        try:
            updates = telegram("getUpdates", {"offset": offset or None, "timeout": 25, "allowed_updates": ["message"]}, timeout=40) or []
        except Exception:
            time.sleep(10)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            msg = update.get("message") or {}
            if (msg.get("from") or {}).get("id") != owner or msg.get("chat", {}).get("type") != "private":
                continue
            text = (msg.get("text") or "").strip()
            if text.startswith("/allumer") or text.startswith("/start"):
                # On confirme la lecture avant d'allumer : sinon le dot relirait « /allumer ».
                telegram("getUpdates", {"offset": offset, "timeout": 0})
                telegram("sendMessage", {"chat_id": owner, "text": "J'allume le dot…"})
                dot("start")
                log("watcher.start_dot")
                telegram("sendMessage", {"chat_id": owner, "text": "Dot allumé. Je t'écoute."})
                break
            telegram("sendMessage", {"chat_id": owner, "text": "Le dot est éteint, ton message ne lui a pas été transmis. /allumer pour le relancer."})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
