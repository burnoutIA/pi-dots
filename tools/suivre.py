#!/usr/bin/env python3
"""Voir le dot travailler : le run en cours, en direct (./dot suivre). Ctrl-C pour quitter.

Lit state/channel/live.json, que le dot réécrit à chaque étape d'un run de travail. Affiche les
runs les uns après les autres ; entre deux runs, le dernier reste affiché.
"""

import json
import os
import sys
import time
from pathlib import Path

LIVE = Path(os.environ.get("DOT_STATE") or Path(__file__).resolve().parent.parent / "state") / "channel" / "live.json"


def main():
    shown = None
    try:
        while True:
            try:
                live = json.loads(LIVE.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                live = None
            text = live["text"] if live else "Aucun run pour l'instant."
            if live and live["status"] != "running":
                text = "En attente du prochain run. Le dernier :\n\n" + text
            if text != shown:
                shown = text
                sys.stdout.write("\033[2J\033[H" + text + "\n\n(Ctrl-C pour quitter)\n")
                sys.stdout.flush()
            time.sleep(1)
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
