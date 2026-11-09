// Quarantaine : ce que le coffre retient des sessions exposées (voir docs/injections.md).
//
// Une session (un run ou la conversation) est « exposée » dès qu'elle a lu un contenu jugé suspect.
// L'extension dot le signale ici avant que le modèle lise ce contenu. Ce qu'une session exposée
// voulait changer dans le dot (mémoire, tâches planifiées, veilles, objectifs, secrets) est mis de
// côté ici au lieu d'être fait, pour être proposé à la personne.
//
// Tout vit à la racine du dossier du dot (.quarantaine/), que le coffre monte et que le dot ne voit pas.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const text = (v, n) => String(v ?? "").slice(0, n);
const json = (v) => JSON.parse(JSON.stringify(v ?? {}));

export function createQuarantine(dir) {
  const held = join(dir, "held");

  // Une session exposée : on garde quand, laquelle, et ce qui l'a exposée.
  function expose(body) {
    const entry = {
      t: new Date().toISOString(),
      session: text(body.session, 100),
      role: text(body.role, 20),
      tool: text(body.tool, 100),
      level: text(body.level, 20),
      excerpt: text(body.excerpt, 300),
    };
    if (!entry.session) throw Object.assign(new Error("session : l'identifiant de la session exposée"), { status: 400 });
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "exposures.jsonl"), JSON.stringify(entry) + "\n");
    return entry;
  }

  // Un changement mis de côté : l'appel d'outil tel qu'il aurait été fait, et pourquoi il ne l'a pas été.
  function hold(body) {
    if (!body.session || !body.tool) throw Object.assign(new Error("session et tool : la session et l'appel mis de côté"), { status: 400 });
    const entry = {
      id: randomBytes(4).toString("hex"),
      t: new Date().toISOString(),
      session: text(body.session, 100),
      role: text(body.role, 20),
      tool: text(body.tool, 100),
      input: json(body.input),
      exposedBy: json(body.exposedBy),
    };
    if (JSON.stringify(entry).length > 100_000) throw Object.assign(new Error("changement trop gros pour être mis de côté"), { status: 413 });
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, `${entry.id}.json`), JSON.stringify(entry, null, 2));
    return entry;
  }

  function list() {
    try {
      return readdirSync(held)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(held, f), "utf8")))
        .sort((a, b) => a.t.localeCompare(b.t));
    } catch {
      return [];
    }
  }

  function get(id) {
    if (!/^[0-9a-f]{8}$/.test(String(id))) return null;
    try {
      return JSON.parse(readFileSync(join(held, `${id}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  // Les fichiers retirés d'une entrée, pour les montrer à la personne (le début de chacun).
  function files(entry, max = 4000) {
    return (entry.changes ?? [])
      .filter((c) => !c.item && !String(c.change).startsWith("supprimé"))
      .map((c) => {
        try {
          return { path: c.path, text: readFileSync(join(held, entry.id, "files", c.path), "utf8").slice(0, max) };
        } catch {
          return { path: c.path, text: "" };
        }
      });
  }

  function remove(id) {
    rmSync(join(held, `${id}.json`), { force: true });
    rmSync(join(held, id), { recursive: true, force: true });
  }

  // Ce qui attend depuis plus de `days` jours est jeté.
  function expire(days = 7, now = Date.now()) {
    const old = list().filter((e) => now - Date.parse(e.t) > days * 86_400_000);
    for (const e of old) remove(e.id);
    return old;
  }

  return { expose, hold, list, get, files, remove, expire };
}
