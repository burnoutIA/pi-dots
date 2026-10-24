#!/usr/bin/env python3
"""Parler au dot depuis la machine : le même canal que Telegram, sans Telegram.

  ./dot ask "message"          une question, la réponse s'affiche
  ./dot chat                   une conversation au clavier (/status /pause /resume /new /send /allumer /eteindre /quit)
  ./dot send fichier [message] déposer un fichier au dot
  ./dot secret                 répondre à une demande de secret du coffre
  ./dot livrables              ce que le dot a produit pour toi

Messages et réponses passent par state/channel. Les secrets, jamais : ils sont remis directement au
coffre (porte d'administration à l'intérieur de son conteneur), saisis sans s'afficher.
"""

import getpass
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get("DOT_STATE") or ROOT / "state")
NAME = os.environ.get("DOT_NAME", "dot")
CONTAINER = os.environ.get("DOT_CONTAINER", NAME)
DIR = os.environ.get("DOT_DIR", str(ROOT))
CLI = os.environ.get("DOT_CLI") or str(ROOT / "dot")
CHANNEL = STATE / "channel"
IN, OUT = CHANNEL / "in", CHANNEL / "out"
NOTIFICATIONS = CHANNEL / "notifications.jsonl"
CURSOR = CHANNEL / ".lu"
LIVRABLES = STATE / "livrables"
ENGINE = os.environ.get("DOT_ENGINE_BIN", "podman")
VAULT = os.environ.get("DOT_VAULT_NAME", "dot-vault")
lock = threading.Lock()


def say(text: str = ""):
    with lock:
        print(text, flush=True)


# --- Coffre : porte d'administration, jointe en entrant dans son conteneur ---

def vault(method: str, path: str, body=None):
    cmd = [ENGINE, "exec", "-i", VAULT, "curl", "-s", "-m", "20", "-X", method, "-H", "content-type: application/json", f"http://127.0.0.1:8081{path}"]
    if body is not None:
        cmd[6:6] = ["--data-binary", "@-"]
    try:
        out = subprocess.run(cmd, input=json.dumps(body) if body is not None else None, capture_output=True, text=True, timeout=30)
        return json.loads(out.stdout or "{}")
    except Exception:
        return {}


def pending():
    return vault("GET", "/pending").get("pending")


def answer_secret(request) -> None:
    """Pose la question à la personne et remet la réponse au coffre. La valeur ne s'affiche pas."""
    if request["type"] == "extend":
        say(f"\n🔐 Le dot demande d'élargir un accès : {', '.join(request['names'])} → en plus {', '.join(request['hosts'])}")
        say(f"   Pour : {request['purpose']}")
        text = input("   oui / non (ou /annuler) : ").strip()
    else:
        if request["step"].startswith("1/"):
            say(f"\n🔐 Le dot demande un accès. Ta réponse va au coffre, pas au dot.")
            say(f"   Pour : {request['purpose']}")
            say(f"   Envoyé uniquement à : {', '.join(request['hosts'])}" + (" · lecture seule" if request.get("readOnly") else " · lecture et écriture"))
        replaces = " (remplace la valeur enregistrée)" if request.get("replaces") else ""
        text = getpass.getpass(f"   {request['step']} · {request['label']} ({request['name']}){replaces} — valeur, ou /annuler : ")
    result = vault("POST", "/answer", {"id": request["id"], "text": text})
    say(f"   {result.get('message', 'Le coffre ne répond pas.')}")


def secrets_loop():
    """Toutes les demandes de secret en cours, une par une."""
    request = pending()
    if not request:
        say("Aucune demande de secret en cours.")
    while request:
        answer_secret(request)
        request = pending()


# --- Messages ---

def new_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)


def post(message: dict) -> str:
    IN.mkdir(parents=True, exist_ok=True)
    message.setdefault("id", new_id())
    tmp = IN / f".{message['id']}.tmp"
    tmp.write_text(json.dumps(message, ensure_ascii=False))
    tmp.rename(IN / f"{message['id']}.json")
    return message["id"]


def take_reply(msg_id: str):
    file = OUT / f"{msg_id}.json"
    if not file.exists():
        return None
    reply = json.loads(file.read_text()).get("reply", "")
    file.unlink(missing_ok=True)
    return reply


def new_notifications():
    if not NOTIFICATIONS.exists():
        return []
    offset = int(CURSOR.read_text()) if CURSOR.exists() else 0
    with NOTIFICATIONS.open(encoding="utf-8") as f:
        f.seek(offset)
        lines = f.readlines()
        CURSOR.write_text(str(f.tell()))
    return [json.loads(l) for l in lines if l.strip()]


def show_notifications():
    for n in new_notifications():
        say(f"\n📣 {datetime.fromisoformat(n['t'].replace('Z', '+00:00')).astimezone():%H:%M} · {n['text']}")


def wait_reply(msg_id: str, timeout: int = 1800, interactive_secrets: bool = True) -> str:
    start = time.time()
    while time.time() - start < timeout:
        reply = take_reply(msg_id)
        if reply is not None:
            return reply
        show_notifications()
        if interactive_secrets:
            request = pending()
            if request:
                answer_secret(request)
        time.sleep(1)
    return "(pas de réponse : le dot est-il démarré ? ./dot status)"


def running() -> bool:
    out = subprocess.run([ENGINE, "inspect", "-f", "{{.State.Running}}", CONTAINER], capture_output=True, text=True)
    return out.stdout.strip() == "true"


def power(action: str):
    """./dot start ou ./dot stop, depuis le chat."""
    subprocess.run([CLI, DIR, action])


def ensure_running(ask: bool = True):
    if running():
        return
    if ask and sys.stdin.isatty():
        if input("Le dot est éteint. Je l'allume ? [O/n] ").strip().lower() in ("n", "non", "no"):
            sys.exit(0)
    else:
        say("Le dot était éteint : je l'allume.")
    power("start")
    time.sleep(10)  # le temps que pi démarre et lise ses messages


def send_file(path: str, text: str = "") -> str:
    src = Path(path).expanduser()
    if not src.is_file():
        sys.exit(f"Fichier introuvable : {path}")
    dest_dir = STATE / "workspace" / "files"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{datetime.now():%Y%m%d-%H%M%S}-{src.name}"
    shutil.copy2(src, dest)
    note = f"[La personne t'a déposé un fichier : /dot/workspace/files/{dest.name} ({src.stat().st_size} octets)]"
    return post({"text": f"{text}\n\n{note}".strip()})


# --- Commandes ---

def cmd_ask(args):
    if not args:
        sys.exit('Usage : ./dot ask "message"')
    ensure_running(ask=False)
    say(wait_reply(post({"text": " ".join(args)})))


def cmd_send(args):
    ensure_running()
    if not args:
        sys.exit("Usage : ./dot send fichier [message]")
    say(wait_reply(send_file(args[0], " ".join(args[1:]))))


def cmd_livrables(_args):
    files = sorted((p for p in LIVRABLES.rglob("*") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True) if LIVRABLES.exists() else []
    if not files:
        say(f"Aucun livrable pour l'instant ({LIVRABLES}).")
    for p in files[:30]:
        size = p.stat().st_size
        human = f"{size} o" if size < 1024 else f"{size // 1024} Ko" if size < 2**20 else f"{size / 2**20:.1f} Mo"
        say(f"{datetime.fromtimestamp(p.stat().st_mtime):%d/%m %H:%M}  {human:>8}  {p.relative_to(LIVRABLES)}")
    if files:
        say(f"\nDossier : {LIVRABLES}")


def cmd_chat(_args):
    ensure_running()
    say("Conversation avec le dot. /aide pour ses commandes ; ici aussi : /send fichier [message] /secret /livrables /allumer /eteindre /quit")
    stop = threading.Event()
    waiting: list[str] = []
    busy = threading.Event()  # une saisie de secret est en cours

    def background():
        while not stop.is_set():
            for msg_id in list(waiting):
                reply = take_reply(msg_id)
                if reply is not None:
                    waiting.remove(msg_id)
                    say(f"\n🤖 {reply}\n")
            show_notifications()
            if not busy.is_set() and pending():
                say("\n🔐 Le coffre attend une réponse : tape /secret")
            time.sleep(2 if not busy.is_set() else 5)

    threading.Thread(target=background, daemon=True).start()
    try:
        while True:
            line = input("toi › ").strip()
            if not line:
                continue
            if line in ("/quit", "/exit"):
                break
            if line == "/secret":
                busy.set()
                try:
                    secrets_loop()
                finally:
                    busy.clear()
                continue
            if line == "/livrables":
                cmd_livrables([])
                continue
            if line == "/eteindre":
                power("stop")
                continue
            if line == "/allumer":
                if running():
                    say("Le dot est déjà allumé.")
                else:
                    power("start")
                continue
            if not running():
                say("Le dot est éteint : /allumer pour le relancer.")
                continue
            if line.startswith("/send "):
                parts = line.split(maxsplit=2)
                waiting.append(send_file(parts[1], parts[2] if len(parts) > 2 else ""))
                continue
            if line.startswith("/"):
                # Toutes les autres commandes vont au dot : les siennes et celles de ses skills (/aide).
                waiting.append(post({"command": line}))
                continue
            waiting.append(post({"text": line}))
    except (EOFError, KeyboardInterrupt):
        pass
    stop.set()
    say("")


def main(argv):
    command, args = (argv[0], argv[1:]) if argv else ("chat", [])
    handlers = {"ask": cmd_ask, "chat": cmd_chat, "send": cmd_send, "secret": lambda a: secrets_loop(), "livrables": cmd_livrables}
    if command not in handlers:
        sys.exit(__doc__)
    handlers[command](args)


if __name__ == "__main__":
    main(sys.argv[1:])
