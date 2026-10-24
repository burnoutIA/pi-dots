#!/usr/bin/env python3
"""Un dot dans un seul fichier : ./dot export et ./dot import.

Un fichier .dot est un modèle de dot : sa configuration et ses savoir-faire, sans son passé.
  - dedans : .env, config/ (models.json, vault.json avec les secrets), et de state/ ses skills et
    ses propres extensions ;
  - pas dedans : sessions, mémoire, plan, journal, fichiers de travail, livrables, navigateur.
Un dot importé repart donc à neuf, avec ses accès et ses savoir-faire déjà en place.

  ./dot @nom export [fichier.dot]       par défaut dots/<nom>.dot
  ./dot import fichier.dot [nom]        crée dots/<nom>/ (par défaut : le nom d'origine)

C'est un fichier JSON lisible : on peut l'ouvrir et le corriger dans un éditeur avant de l'importer.
Il contient les secrets en clair : garde-le comme un trousseau de clés.
"""

import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOTS = ROOT / "dots"
FORMAT = 2  # un fichier JSON lisible
# Extensions fournies par le dépôt : remises à chaque démarrage, inutile de les emporter.
MANAGED = {"dot", "dot-telegram", "dot-local", "ctx-optimizer"}
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}


def dot_dir(name: str) -> Path:
    return ROOT if name == "dot" else DOTS / name


def collect(src: Path):
    """(chemin dans l'archive, fichier) pour tout ce qui part dans le modèle."""
    for rel in (".env", "config/models.json", "config/vault.json"):
        if (src / rel).is_file():
            yield rel, src / rel
    agent = src / "state" / "agent"
    for kind in ("skills", "extensions"):
        base = agent / kind
        if not base.is_dir():
            continue
        for item in sorted(base.iterdir()):
            if kind == "extensions" and item.name in MANAGED:
                continue
            for path in sorted(item.rglob("*")) if item.is_dir() else [item]:
                if path.is_file() and not SKIP_DIRS.intersection(path.relative_to(base).parts):
                    yield f"state/agent/{kind}/{path.relative_to(base)}", path


def content(path: Path):
    """Le contenu d'un fichier : du texte tel quel, sinon {"base64": …}."""
    data = path.read_bytes()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return {"base64": base64.b64encode(data).decode()}


def export(name: str, target: str | None):
    src = dot_dir(name)
    if not (src / ".env").is_file():
        sys.exit(f"Pas de dot « {name} ».")
    out = Path(target) if target else DOTS / f"{name}.dot"
    out.parent.mkdir(parents=True, exist_ok=True)
    read_json = lambda p: json.loads(p.read_text()) if p.is_file() else None
    doc = {
        "format": FORMAT,
        "name": name,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "env": (src / ".env").read_text().splitlines(),
        "models": read_json(src / "config/models.json"),
        "vault": read_json(src / "config/vault.json") or {"secrets": {}, "allow": []},
        "skills": {},
        "extensions": {},
    }
    for arc, path in collect(src):
        parts = arc.split("/")
        if parts[0] == "state":  # state/agent/<skills|extensions>/<nom>/<fichier…>
            doc[parts[2]].setdefault(parts[3], {})["/".join(parts[4:]) or parts[3]] = content(path)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)  # il contient des secrets
    tmp.replace(out)
    print(f"Modèle « {name} » exporté dans {out}")
    print(f"  skills : {', '.join(doc['skills']) or 'aucun'} · extensions : {', '.join(doc['extensions']) or 'aucune'} · secrets : {', '.join(doc['vault'].get('secrets', {})) or 'aucun'}")
    print("  Fichier JSON lisible, avec les secrets en clair : garde-le comme un trousseau de clés.")


def check_name(name: str, file: str) -> Path:
    import re
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", name) or name == "dot":
        sys.exit(f"Nom invalide : « {name} » (minuscules, chiffres, tirets ; « dot » est réservé). Donne un autre nom : ./dot import {file} autre-nom")
    target = DOTS / name
    if target.exists():
        sys.exit(f"Le dot « {name} » existe déjà. Donne un autre nom : ./dot import {file} autre-nom")
    return target


def write_files(base: Path, files: dict):
    for rel, data in files.items():
        p = Path(rel)
        if p.is_absolute() or ".." in p.parts:
            continue  # rien ne sort du dossier du dot
        dest = base / p
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(base64.b64decode(data["base64"]) if isinstance(data, dict) else str(data).encode())


def import_(file: str, name: str | None):
    path = Path(file)
    if not path.is_file() and (DOTS / file).is_file():
        path = DOTS / file
    if not path.is_file():
        sys.exit(f"Fichier introuvable : {file}")
    raw = path.read_bytes()
    try:
        doc = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        sys.exit(f"Ce n'est pas un fichier .dot lisible : {e}")
    if doc.get("format") != FORMAT:
        sys.exit(f"Format de fichier .dot inconnu : {doc.get('format')}")
    name = name or doc.get("name", "")
    target = check_name(name, file)
    (target / "config").mkdir(parents=True)
    (target / ".env").write_text("\n".join(doc.get("env", [])) + "\n")
    if doc.get("models") is not None:
        (target / "config/models.json").write_text(json.dumps(doc["models"], indent=2, ensure_ascii=False) + "\n")
    (target / "config/vault.json").write_text(json.dumps(doc.get("vault") or {"secrets": {}, "allow": []}, indent=2, ensure_ascii=False) + "\n")
    for kind in ("skills", "extensions"):
        for item, files in (doc.get(kind) or {}).items():
            if kind == "extensions" and item in MANAGED or "/" in item or item.startswith("."):
                continue
            write_files(target / "state" / "agent" / kind / item, files)
    skills, secrets = list(doc.get("skills") or {}), list((doc.get("vault") or {}).get("secrets", {}))
    # Un bot Telegram n'a qu'un lecteur : le dot importé démarre sans Telegram.
    env = target / ".env"
    if env.is_file():
        lines = ["TELEGRAM_OWNER_ID=" if l.startswith("TELEGRAM_OWNER_ID=") else l for l in env.read_text().splitlines()]
        env.write_text("\n".join(lines) + "\n")
    if (target / "config/vault.json").is_file():
        os.chmod(target / "config/vault.json", 0o600)
    (target / "state").mkdir(exist_ok=True)
    print(f"Dot « {name} » créé depuis {path.name} (sans son passé, sans Telegram).")
    print(f"  skills : {', '.join(skills) or 'aucun'} · secrets : {', '.join(secrets) or 'aucun'}")
    print(f"Lance-le avec : ./dot @{name} start")


def main(argv):
    if not argv:
        sys.exit(__doc__)
    command, rest = argv[0], argv[1:]
    if command == "export":
        export(os.environ.get("DOT_NAME", "dot"), rest[0] if rest else None)
    elif command == "import":
        if not rest:
            sys.exit("Usage : ./dot import fichier.dot [nom]")
        import_(rest[0], rest[1] if len(rest) > 1 else None)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
