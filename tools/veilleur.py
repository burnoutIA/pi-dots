#!/usr/bin/env python3
"""Le veilleur : allumer et éteindre les dots à distance, depuis Telegram. Un seul pour tous.

Il tourne sur la machine, hors des dots (service de session : ./dot veilleur install). Il suit les
dots connus de l'application (~/.local/share/dots/known) et, pour chacun qui a Telegram :
  - dot éteint : il écoute son bot à sa place. /allumer le lance ; tout autre message reçoit
    « je suis éteint » ;
  - dot allumé : il n'écoute pas son bot (un bot n'a qu'un lecteur : c'est le dot). Il surveille
    seulement la demande d'extinction que le dot lui transmet (/eteindre).
Un fil par dot. Un dot ajouté ou retiré est pris en compte dans la minute. Pour chaque dot, il
signale qu'il veille dans state/channel/veilleur.json et note ce qu'il fait au journal du dot.
"""

import hashlib
import json
import os
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = os.environ.get("DOT_CLI") or str(ROOT / "dot")
ENGINE = os.environ.get("DOT_ENGINE_BIN", "podman")
KNOWN = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "dots" / "known"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Watch(threading.Thread):
    """Le veilleur d'un dot."""

    def __init__(self, directory: Path, dotfile: Path):
        super().__init__(daemon=True)
        self.dir, self.dotfile = directory, dotfile
        self.name_ = dotfile.stem
        self.container = f"dot-{self.name_}-{hashlib.sha1(str(directory).encode()).hexdigest()[:6]}"
        state = directory / "state"
        self.channel, self.logs, self.state_file = state / "channel", state / "logs", state / "memory" / "state.json"
        self.stopping = threading.Event()
        self.owner, self.token = 0, ""
        self.config_mtime = None

    def log(self, kind: str, **data):
        try:
            self.logs.mkdir(parents=True, exist_ok=True)
            with (self.logs / f"{datetime.now():%Y-%m-%d}.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps({"t": now(), "role": "veilleur", "type": kind, **data}, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def config(self) -> bool:
        """Identifiant et jeton, relus quand le fichier du dot change (./dot <dossier> telegram-config)."""
        try:
            mtime = self.dotfile.stat().st_mtime
        except OSError:
            return False
        if mtime != self.config_mtime:
            out = subprocess.run([CLI, str(self.dir), "telegram-config"], capture_output=True, text=True)
            lines = (out.stdout.splitlines() + ["", ""])[:2]
            self.owner = int(lines[0].strip() or 0) if lines[0].strip().isdigit() else 0
            self.token = lines[1].strip()
            self.config_mtime = mtime
        return bool(self.owner and self.token)

    def telegram(self, method: str, params: dict, timeout: int = 30):
        req = urllib.request.Request(f"https://api.telegram.org/bot{self.token}/{method}", data=json.dumps(params).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("result")

    def say(self, text: str):
        try:
            self.telegram("sendMessage", {"chat_id": self.owner, "text": text})
        except Exception:
            pass

    def running(self) -> bool:
        # Le dot écrit un signe de vie toutes les 15 s : le lire ne coûte rien. Le moteur, en cas de doute.
        try:
            alive = json.loads(self.state_file.read_text()).get("lastAlive")
            if alive and time.time() - datetime.fromisoformat(alive.replace("Z", "+00:00")).timestamp() < 60:
                return True
        except Exception:
            pass
        out = subprocess.run([ENGINE, "inspect", "-f", "{{.State.Running}}", self.container], capture_output=True, text=True)
        return out.stdout.strip() == "true"

    def dot(self, action: str):
        subprocess.run([CLI, str(self.dir), action], capture_output=True)

    def run(self):
        self.log("watcher.start")
        offset = 0
        while not self.stopping.is_set():
            if not self.config():
                self.stopping.wait(60)  # pas (ou plus) de Telegram pour ce dot
                continue
            try:
                self.channel.mkdir(parents=True, exist_ok=True)
                (self.channel / "veilleur.json").write_text(json.dumps({"t": now()}))
            except OSError:
                pass

            # Le dot demande à être éteint (/eteindre sur Telegram).
            power = self.channel / "power.json"
            if power.exists():
                try:
                    action = json.loads(power.read_text()).get("action")
                except Exception:
                    action = None
                power.unlink(missing_ok=True)
                if action == "stop" and self.running():
                    self.dot("stop")
                    self.log("watcher.stop")
                    self.say("Dot éteint. /allumer pour le relancer.")

            if self.running():
                offset = 0  # le dot lit lui-même ses messages ; on reprendra à sa suite
                self.stopping.wait(10)
                continue

            # Dot éteint : le veilleur écoute son bot à sa place.
            try:
                updates = self.telegram("getUpdates", {"offset": offset or None, "timeout": 25, "allowed_updates": ["message"]}, timeout=40) or []
            except Exception:
                self.stopping.wait(10)
                continue
            for update in updates:
                offset = update["update_id"] + 1
                msg = update.get("message") or {}
                if (msg.get("from") or {}).get("id") != self.owner or msg.get("chat", {}).get("type") != "private":
                    continue
                text = (msg.get("text") or "").strip()
                if text.startswith("/allumer") or text.startswith("/start"):
                    # On confirme la lecture avant d'allumer : sinon le dot relirait « /allumer ».
                    self.telegram("getUpdates", {"offset": offset, "timeout": 0})
                    self.say(f"J'allume {self.name_}…")
                    self.dot("start")
                    self.log("watcher.start_dot")
                    self.say(f"{self.name_} est allumé. Je t'écoute.")
                    break
                self.say(f"{self.name_} est éteint, ton message ne lui a pas été transmis. /allumer pour le relancer.")


def known_dots() -> dict:
    """Dossier → fichier .dot, pour les dots connus qui existent encore."""
    dots = {}
    try:
        lines = KNOWN.read_text().splitlines()
    except FileNotFoundError:
        return dots
    for line in lines:
        if "\t" not in line:
            continue
        directory = Path(line.split("\t", 1)[1])
        files = list(directory.glob("*.dot"))
        if len(files) == 1:
            dots[directory] = files[0]
    return dots


def main():
    watches: dict = {}
    while True:
        current = known_dots()
        for directory, dotfile in current.items():
            if directory not in watches or not watches[directory].is_alive():
                watches[directory] = Watch(directory, dotfile)
                watches[directory].start()
        for directory in list(watches):
            if directory not in current:
                watches.pop(directory).stopping.set()
        time.sleep(60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
