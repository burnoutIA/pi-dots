#!/usr/bin/env python3
"""Un dot dans un seul fichier : ./dot export et ./dot import.

Un fichier .dot est un modèle de dot : sa configuration et ses savoir-faire, sans son passé.
  - dedans : .env, config/ (models.json, vault.json avec les secrets), et de state/ ses skills et
    ses propres extensions ;
  - pas dedans : sessions, mémoire, plan, journal, fichiers de travail, livrables, navigateur.
Un dot importé repart donc à neuf, avec ses accès et ses savoir-faire déjà en place.

  ./dot @nom export [fichier.dot]       par défaut dots/<nom>.dot
  ./dot import fichier.dot [nom]        crée dots/<nom>/ (par défaut : le nom d'origine)

Le fichier contient les secrets en clair : garde-le comme un trousseau de clés.
"""

import io
import json
import os
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOTS = ROOT / "dots"
FORMAT = 1
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


def export(name: str, target: str | None):
    src = dot_dir(name)
    if not (src / ".env").is_file():
        sys.exit(f"Pas de dot « {name} ».")
    out = Path(target) if target else DOTS / f"{name}.dot"
    out.parent.mkdir(parents=True, exist_ok=True)
    files = list(collect(src))
    manifest = {
        "format": FORMAT,
        "name": name,
        "created": datetime.now(timezone.utc).isoformat(),
        "skills": sorted({p.split("/")[3] for p, _ in files if p.startswith("state/agent/skills/")}),
        "extensions": sorted({p.split("/")[3] for p, _ in files if p.startswith("state/agent/extensions/")}),
        "secrets": sorted(json.loads((src / "config/vault.json").read_text()).get("secrets", {}).keys()) if (src / "config/vault.json").is_file() else [],
    }
    tmp = out.with_suffix(".tmp")
    with tarfile.open(tmp, "w:gz") as tar:
        data = json.dumps(manifest, indent=2, ensure_ascii=False).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
        for arc, path in files:
            tar.add(path, arcname=arc, recursive=False)
    os.chmod(tmp, 0o600)  # il contient des secrets
    tmp.replace(out)
    print(f"Modèle « {name} » exporté dans {out}")
    print(f"  skills : {', '.join(manifest['skills']) or 'aucun'} · extensions : {', '.join(manifest['extensions']) or 'aucune'} · secrets : {', '.join(manifest['secrets']) or 'aucun'}")
    print("  Ce fichier contient les secrets en clair : garde-le comme un trousseau de clés.")


def safe_members(tar: tarfile.TarFile):
    """Seulement ce qu'un modèle peut contenir, sans chemin qui sorte du dossier du dot."""
    allowed = (".env", "config/models.json", "config/vault.json")
    for m in tar.getmembers():
        p = Path(m.name)
        if m.name == "manifest.json" or p.is_absolute() or ".." in p.parts or not (m.isfile() or m.isdir()):
            continue
        if m.name in allowed or m.name.startswith(("state/agent/skills/", "state/agent/extensions/")):
            yield m


def import_(file: str, name: str | None):
    path = Path(file)
    if not path.is_file() and (DOTS / file).is_file():
        path = DOTS / file
    if not path.is_file():
        sys.exit(f"Fichier introuvable : {file}")
    with tarfile.open(path, "r:gz") as tar:
        try:
            manifest = json.load(tar.extractfile("manifest.json"))
        except (KeyError, json.JSONDecodeError):
            sys.exit("Ce n'est pas un fichier .dot (manifest.json absent).")
        if manifest.get("format") != FORMAT:
            sys.exit(f"Format de fichier .dot inconnu : {manifest.get('format')}")
        name = name or manifest["name"]
        import re
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", name) or name == "dot":
            sys.exit(f"Nom invalide : « {name} » (minuscules, chiffres, tirets ; « dot » est réservé). Donne un autre nom : ./dot import {file} autre-nom")
        target = DOTS / name
        if target.exists():
            sys.exit(f"Le dot « {name} » existe déjà. Donne un autre nom : ./dot import {file} autre-nom")
        target.mkdir(parents=True)
        tar.extractall(target, members=list(safe_members(tar)), filter="data")
    # Un bot Telegram n'a qu'un lecteur : le dot importé démarre sans Telegram.
    env = target / ".env"
    if env.is_file():
        lines = ["TELEGRAM_OWNER_ID=" if l.startswith("TELEGRAM_OWNER_ID=") else l for l in env.read_text().splitlines()]
        env.write_text("\n".join(lines) + "\n")
    if (target / "config/vault.json").is_file():
        os.chmod(target / "config/vault.json", 0o600)
    (target / "state").mkdir(exist_ok=True)
    print(f"Dot « {name} » créé depuis {path.name} (sans son passé, sans Telegram).")
    print(f"  skills : {', '.join(manifest.get('skills', [])) or 'aucun'} · secrets : {', '.join(manifest.get('secrets', [])) or 'aucun'}")
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
