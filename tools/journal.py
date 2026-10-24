#!/usr/bin/env python3
"""Lire le journal du dot (state/logs/AAAA-MM-JJ.jsonl) depuis la machine hôte.

  ./dot journal                  aujourd'hui
  ./dot journal 2026-10-21       un autre jour
  ./dot journal -p               seulement les problèmes (échecs, boucles, blocages, plantages)
  ./dot journal -f               suivre en direct
  ./dot journal --runs           un run par ligne : début, fin, durée, résultat
  ./dot journal --reseau         avec chaque sortie réseau du dot (vue par le coffre)
"""

import json
import sys
import time
from datetime import date, datetime
from pathlib import Path

LOGS = Path(__file__).resolve().parent.parent / "state" / "logs"
PROBLEMS = {"notify.blocked", "model.down", "model.up", "loop.suspect", "todo.stuck", "heartbeat.error", "pi.exit", "schedule.skipped", "net.denied", "net.error", "oauth.error"}


def hour(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")


def duration(seconds) -> str:
    seconds = int(seconds or 0)
    if seconds < 60:
        return f"{seconds} s"
    if seconds < 3600:
        return f"{seconds // 60} min {seconds % 60:02d}"
    return f"{seconds // 3600} h {seconds % 3600 // 60:02d}"


def tools(e) -> str:
    items = sorted((e.get("tools") or {}).items(), key=lambda kv: -kv[1])
    return ", ".join(f"{name}×{n}" for name, n in items[:6]) or "aucun"


def short(text, n=110) -> str:
    text = str(text or "")
    return text if len(text) <= n else text[: n - 1] + "…"


def is_problem(e) -> bool:
    return e["type"] in PROBLEMS or (e["type"] == "run.end" and not e.get("ok"))


def describe(e) -> str:
    t = e["type"]
    if t == "run.start":
        return f"▶ run {e.get('kind')} · {short(e.get('label'))}  [{e.get('session')}]"
    if t == "run.end":
        state = "ok" if e.get("ok") else "ÉCHEC"
        if e.get("timedOut"):
            state = "ARRÊTÉ (trop long)"
        line = (f"■ run fini {state} · {duration(e.get('durationS'))} · {e.get('turns', 0)} tours · "
                f"{e.get('toolCalls', 0)} outils ({tools(e)}) · {round((e.get('tokensIn', 0) + e.get('tokensOut', 0)) / 1000)}k jetons")
        if e.get("maxRepeat", 0) >= 3:
            line += f" · même appel répété {e['maxRepeat']}×"
        if e.get("modelUnavailable"):
            line += " · modèle injoignable (non compté)"
        elif e.get("error"):
            line += f"\n           erreur : {e['error'][:300]}"
        return line
    if t == "loop.suspect":
        return f"⚠ BOUCLE {'arrêtée' if e.get('stopped') else 'probable'} après {duration(e.get('sinceStartS'))} : {e.get('call')} répété {e.get('repeat')}× · {short(e.get('label'), 60)}"
    if t == "todo.stuck":
        return f"⚠ BLOQUÉ : todo {e.get('todo')} ({e.get('reason')})"
    if t == "plan.change":
        what = short(e.get("text") or e.get("title") or e.get("status") or "", 90)
        target = e.get("todo") or e.get("objective")
        return f"· {e.get('tool')} {e.get('action')} {target} {what}".rstrip()
    if t == "plan.unchanged":
        return f"· plan inchangé pour {e.get('objective')} : réexaminé dans {e.get('recheckInMin')} min"
    if t == "event.queued":
        detail = e.get("schedule") or e.get("watch") or e.get("file") or ""
        late = f" (en retard de {e['lateMin']} min)" if e.get("lateMin", 0) > 15 else ""
        return f"↓ événement {e.get('kind')} {detail}{late}"
    if t == "schedule.skipped":
        return f"⚠ tâche {e.get('schedule')} sautée (en retard de {e.get('lateMin')} min, sans rattrapage)"
    if t == "memory.remember":
        return f"🧠 retenu : {e.get('fact')}"
    if t == "memory.forget":
        return f"🧠 oublié : {e.get('match')}"
    if t == "skills.broken":
        return f"⚠ skills non chargés (en-tête manquant) : {', '.join(e.get('skills') or [])}"
    if t == "mail.read":
        return f"✉ coffre : mails lus ({e.get('action')} {e.get('folder', '')}, {e.get('count')}) sur {e.get('host')}"
    if t == "notify.blocked":
        return f"⛔ notify bloqué ({e.get('reason')}) : {e.get('text', '')[:80]}"
    if t == "model.down":
        return f"⚠ modèle injoignable (essai {e.get('tries')}) : travail en attente, nouvel essai dans {e.get('retryInMin')} min · {e.get('error', '')[:120]}"
    if t == "model.up":
        return f"✅ modèle de retour après {e.get('downForMin')} min : reprise du travail"
    if t == "secret.requested":
        return f"🔐 secret demandé à la personne : {', '.join(e.get('names') or [])} → {', '.join(e.get('hosts') or [])} · {e.get('purpose', '')}"
    if t == "secret.saved":
        return f"🔐 secret enregistré : {', '.join(e.get('names') or [])} → {', '.join(e.get('hosts') or [])}{' (lecture seule)' if e.get('readOnly') else ''}"
    if t == "secret.extended":
        return f"🔐 accès élargi : {', '.join(e.get('names') or [])} → + {', '.join(e.get('hosts') or [])}"
    if t == "secret.expired":
        return f"🔐 demande de secret expirée sans réponse : {', '.join(e.get('names') or [])}"
    if t == "secret.cancelled":
        return f"🔐 demande de secret refusée par la personne : {', '.join(e.get('names') or [])}"
    if t in ("secret.request", "oauth.refresh"):
        return ""
    if t == "oauth.error":
        return f"⚠ coffre : jeton {e.get('secret')} non renouvelé ({e.get('error')} {e.get('detail') or ''})"
    if t == "net.denied":
        return f"⛔ coffre : refusé {e.get('method', '')} {e.get('host') or e.get('route') or e.get('url', '')} ({e.get('error')})".replace("  ", " ")
    if t == "net.error":
        return f"⚠ coffre : erreur {e.get('method', '')} {e.get('host') or e.get('route') or e.get('url', '')} ({e.get('error') or e.get('status')})"
    if t == "net.out":
        return f"→ sortie {e.get('method')} {e.get('host')}:{e.get('port')}"
    if t == "vault.start":
        return f"● coffre démarré (secrets : {', '.join(e.get('secrets') or e.get('routes') or []) or 'aucun'})"
    if t == "notify":
        return f"✉ notify ({e.get('channel')}) : {e.get('text')}"
    if t == "pi.exit":
        hint = " (tué : mémoire ?)" if e.get("code") == 137 else ""
        return f"⚠ le pi de la conversation s'est arrêté, code {e.get('code')}{hint}, après {duration(e.get('uptimeS'))}"
    if t == "heartbeat.error":
        return f"⚠ erreur du battement : {e.get('error', '')[:300]}"
    if t == "conversation.start":
        extra = []
        if e.get("interrupted"):
            extra.append(f"run interrompu : {e['interrupted']}")
        if e.get("todosInProgress"):
            extra.append(f"todos à reprendre : {', '.join(e['todosInProgress'])}")
        if e.get("paused"):
            extra.append("autonomie en pause")
        return "● conversation démarrée" + (f" ({'; '.join(extra)})" if extra else "")
    labels = {
        "environment.start": "● environnement démarré",
        "environment.stop": "● environnement arrêté",
        "conversation.stop": "● conversation arrêtée",
        "vault.stop": "● coffre arrêté",
        "autonomy.pause": "⏸ autonomie en pause",
        "autonomy.resume": "▶ autonomie reprise",
    }
    return labels.get(t, f"{t} {json.dumps({k: v for k, v in e.items() if k not in ('t', 'type', 'role', 'pid')}, ensure_ascii=False)}")


def read(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def show(e, problems_only: bool):
    if problems_only and not is_problem(e):
        return
    if e["type"] == "net.out" and not NETWORK:
        return
    text = describe(e)
    if text:
        print(f"{hour(e['t'])}  {text}")


def runs(path: Path):
    open_runs = {}
    print("début     fin       durée       résultat  outils  run")
    for e in read(path):
        key = (e.get("session"), e.get("todo"), e.get("kind"))
        if e["type"] == "run.start":
            open_runs[key] = e
        elif e["type"] == "run.end":
            start = open_runs.pop(key, None)
            state = "ok" if e.get("ok") else ("trop long" if e.get("timedOut") else "échec")
            loop = " ⚠ boucle" if e.get("maxRepeat", 0) >= 5 else ""
            print(f"{hour(start['t']) if start else '?':9} {hour(e['t']):9} {duration(e.get('durationS')):11} {state:9} "
                  f"{e.get('toolCalls', 0):6}  {short(e.get('label'), 70)}{loop}")
    for e in open_runs.values():
        print(f"{hour(e['t']):9} {'—':9} {'—':11} {'en cours / coupé':9}        {short(e.get('label'), 70)}")


NETWORK = "--reseau" in sys.argv


def main(args):
    day = next((a for a in args if not a.startswith("-")), date.today().isoformat())
    path = LOGS / f"{day}.jsonl"
    problems_only = "-p" in args or "--problemes" in args
    if "--runs" in args:
        return runs(path)
    if not path.exists() and "-f" not in args:
        days = sorted(p.stem for p in LOGS.glob("*.jsonl"))
        print(f"Pas de journal pour le {day}." + (f" Jours disponibles : {', '.join(days[-10:])}" if days else ""))
        return
    for e in read(path):
        show(e, problems_only)
    if "-f" in args:
        position = path.stat().st_size if path.exists() else 0
        while True:
            time.sleep(1)
            today = LOGS / f"{date.today().isoformat()}.jsonl"
            if today != path:
                path, position = today, 0
            if not path.exists() or path.stat().st_size <= position:
                continue
            with path.open(encoding="utf-8") as f:
                f.seek(position)
                while True:
                    line = f.readline()
                    if not line.endswith("\n"):  # ligne pas encore complète : on la relira
                        break
                    position = f.tell()
                    try:
                        show(json.loads(line), problems_only)
                    except json.JSONDecodeError:
                        pass


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        pass
