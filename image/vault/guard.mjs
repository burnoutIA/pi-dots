// Gardien : ce qu'une session exposée change dans le dot par d'autres moyens que ses outils (bash, un
// script, Python…) est retiré par le coffre et mis en quarantaine. Voir docs/injections.md.
//
// On ne devine pas ce qu'une commande va écrire : on regarde le résultat. Le coffre tient une copie
// de référence de ce qui survit à une session, et la compare régulièrement à ce qui est sur le disque :
//
//   - aucune session exposée en cours : ce qui a changé est accepté, la référence suit ;
//   - une session exposée en cours : ce qui a été ajouté ou modifié est rangé en quarantaine, et le
//     disque est remis comme la référence.
//
// Surveillé : skills/, extensions/, la mémoire (state/memory/MEMORY.md et projets/), et, dans
// state/memory/, la définition des tâches planifiées, des veilles et des objectifs. Leur
// fonctionnement normal (prochaine échéance, état d'une veille, avancement des todos) n'est pas
// comparé, et un retrait n'est pas annulé : il ne peut pas installer d'instructions.
//
// Ce qui oriente le travail des sessions suivantes est suivi aussi : un fichier déposé dans la boîte,
// un événement en file, un todo, la prochaine étape d'un objectif. Ce qui apparaît ou change pendant
// une exposition est marqué « venu d'une session exposée » (origins.json) : un run qui en part
// démarre exposé. Les messages que le coffre dépose lui-même ne sont jamais marqués. Et une session
// pi qui a été exposée est abandonnée (poisoned) : le run suivant repart dans une session neuve.
//
// Une session exposée le reste jusqu'à sa fin annoncée par l'extension (un run qui s'arrête, la
// conversation à /new) ; un run, au moins DOT_RUN_MINUTES après son exposition, pour qu'une fin
// annoncée trop tôt ne serve à rien.

import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TREES = ["skills", "extensions", "state/memory/projets"];
const FILES = ["state/memory/MEMORY.md"];
// Fichiers JSON : la liste, et les champs qui disent ce que l'élément fait (le reste est son fonctionnement).
const RECORDS = [
  { file: "state/memory/schedules.json", list: (d) => d, set: (_d, l) => l, fields: ["prompt", "every", "at", "days", "once", "catchUp"], what: "tâche planifiée" },
  { file: "state/memory/watches.json", list: (d) => d, set: (_d, l) => l, fields: ["command", "every", "prompt"], what: "veille" },
  { file: "state/memory/plan.json", list: (d) => d?.objectives, set: (d, l) => ({ ...d, objectives: l }), fields: ["title", "detail"], what: "objectif", lock: "state/memory/.plan.lock" },
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const pick = (item, fields) => JSON.stringify(fields.map((f) => item?.[f] ?? null));

export function createGuard({ root, qdir, runMinutes = () => 30, log = () => {}, now = () => Date.now() }) {
  const base = join(qdir, "baseline");
  const windowsFile = join(qdir, "windows.json");
  // Les sessions exposées en cours : { session: { role, since, ended } } (survit à un redémarrage).
  let windows = readJson(windowsFile) ?? {};
  // Index de la référence : chemin → { size, mtime, hash } ; reconstruit au démarrage.
  let index = new Map();
  let records = {};
  // Origines : clé (inbox:<fichier>, event:<id>, todo:<id>, objective:<id>) → { hash, tainted, t, gone }.
  const originsFile = join(qdir, "origins.json");
  let origins = readJson(originsFile) ?? { items: {}, trusted: [], poisoned: [] };
  const saveOrigins = () => {
    mkdirSync(qdir, { recursive: true });
    writeFileSync(originsFile, JSON.stringify(origins));
  };

  // Ce qui, sur le disque, oriente les sessions suivantes.
  function sources() {
    const out = new Map();
    try {
      for (const name of readdirSync(join(root, "state", "inbox"))) {
        if (name.startsWith(".")) continue;
        try {
          const file = join(root, "state", "inbox", name);
          if (statSync(file).isFile()) out.set(`inbox:${name}`, sha(readFileSync(file)));
        } catch {}
      }
    } catch {}
    for (const e of readJson(join(root, "state", "memory", "state.json"))?.events ?? []) out.set(`event:${e.id}`, sha(JSON.stringify([e.text, e.source])));
    const plan = readJson(join(root, "state", "memory", "plan.json"));
    for (const t of plan?.todos ?? []) out.set(`todo:${t.id}`, sha(String(t.text ?? "")));
    for (const o of plan?.objectives ?? []) out.set(`objective:${o.id}`, sha(JSON.stringify([o.title, o.detail, o.next, o.blocker])));
    return out;
  }
  function track() {
    const active = open().length > 0;
    const t = now();
    let changed = false;
    const current = sources();
    for (const [key, hash] of current) {
      const prev = origins.items[key];
      const trusted = origins.trusted.includes(key);
      if (!prev) {
        origins.items[key] = { hash, tainted: active && !trusted, t };
        changed = true;
      } else if (prev.hash !== hash || prev.gone) {
        prev.hash = hash;
        delete prev.gone;
        if (active && !trusted) prev.tainted = true;
        changed = true;
      }
    }
    // Ce qui a disparu (traité) est gardé un jour : la question peut arriver juste après.
    for (const [key, item] of Object.entries(origins.items)) {
      if (current.has(key)) continue;
      if (!item.gone) (item.gone = t), (changed = true);
      else if (t - item.gone > 86_400_000) delete origins.items[key], (changed = true);
    }
    if (changed) saveOrigins();
  }

  const saveWindows = () => {
    mkdirSync(qdir, { recursive: true });
    writeFileSync(windowsFile, JSON.stringify(windows, null, 2));
  };

  // Les fichiers surveillés, tels qu'ils sont sur le disque (relatifs à la racine du dot).
  function scan() {
    const out = new Map();
    const walk = (rel) => {
      let entries;
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = join(rel, e.name);
        if (e.isDirectory()) walk(r);
        else if (e.isFile() && !e.name.endsWith(".tmp")) {
          const st = statSync(join(root, r));
          out.set(r, { size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    TREES.forEach(walk);
    for (const f of FILES) {
      try {
        const st = statSync(join(root, f));
        out.set(f, { size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    return out;
  }
  const hashOf = (rel, st, previous) => (previous && previous.size === st.size && previous.mtime === st.mtime ? previous.hash : sha(readFileSync(join(root, rel))));

  // La référence suit le disque : copie de chaque fichier changé, et des définitions JSON.
  function accept(current) {
    const next = new Map();
    for (const [rel, st] of current) {
      const prev = index.get(rel);
      const hash = hashOf(rel, st, prev);
      if (!prev || prev.hash !== hash || !existsSync(join(base, rel))) {
        mkdirSync(dirname(join(base, rel)), { recursive: true });
        cpSync(join(root, rel), join(base, rel));
      }
      next.set(rel, { ...st, hash });
    }
    for (const rel of index.keys()) if (!current.has(rel)) rmSync(join(base, rel), { force: true });
    index = next;
    for (const r of RECORDS) records[r.file] = readJson(join(root, r.file));
  }

  function open() {
    const t = now();
    const floor = runMinutes() * 60_000;
    return Object.entries(windows).filter(([, w]) => !w.ended || (w.role === "run" && t < w.since + floor));
  }

  // Une session exposée : ce qui a changé est mis en quarantaine et le disque remis comme la référence.
  function revert(current) {
    const id = randomBytes(4).toString("hex");
    const dir = join(qdir, "held", id);
    const changes = [];
    for (const [rel, st] of current) {
      const prev = index.get(rel);
      const hash = hashOf(rel, st, prev);
      if (prev && prev.hash === hash) continue;
      mkdirSync(dirname(join(dir, "files", rel)), { recursive: true });
      cpSync(join(root, rel), join(dir, "files", rel));
      if (prev) cpSync(join(base, rel), join(root, rel));
      else rmSync(join(root, rel), { force: true });
      changes.push({ path: rel, change: prev ? "modifié" : "ajouté" });
    }
    for (const rel of index.keys()) {
      if (current.has(rel)) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(base, rel), join(root, rel));
      changes.push({ path: rel, change: "supprimé (remis)" });
    }
    for (const r of RECORDS) {
      const before = records[r.file];
      const file = join(root, r.file);
      const unlock = r.lock ? lock(join(root, r.lock)) : () => {};
      try {
        const data = readJson(file);
        const list = r.list(data);
        if (!Array.isArray(list)) continue;
        const old = new Map((r.list(before) ?? []).map((x) => [x.id, x]));
        const kept = [];
        for (const item of list) {
          const prev = old.get(item.id);
          if (!prev) changes.push({ path: r.file, change: `${r.what} ajouté(e)`, item });
          else if (pick(prev, r.fields) !== pick(item, r.fields)) {
            changes.push({ path: r.file, change: `${r.what} modifié(e)`, item });
            const restored = { ...item };
            for (const f of r.fields) if (prev[f] === undefined) delete restored[f];
            else restored[f] = prev[f];
            kept.push(restored);
          } else kept.push(item);
        }
        if (kept.length !== list.length || changes.some((c) => c.path === r.file)) {
          const tmp = `${file}.guard.tmp`;
          writeFileSync(tmp, JSON.stringify(r.set(data, kept), null, 2) + "\n");
          renameSync(tmp, file);
        }
      } finally {
        unlock();
      }
    }
    if (!changes.length) return null;
    const sessions = open().map(([s]) => s);
    mkdirSync(dir, { recursive: true });
    const entry = { id, t: new Date(now()).toISOString(), kind: "fichiers", sessions, changes };
    writeFileSync(join(qdir, "held", `${id}.json`), JSON.stringify(entry, null, 2));
    log("injection.reverted", { id, sessions, changes: changes.map((c) => `${c.change} : ${c.path}${c.item?.id ? ` (${c.item.id})` : ""}`).slice(0, 20) });
    // La référence ne bouge pas, mais l'index suit les dates des fichiers remis.
    for (const [rel, st] of scan()) {
      const prev = index.get(rel);
      if (prev) index.set(rel, { ...st, hash: prev.hash });
    }
    return entry;
  }

  function check() {
    track();
    const current = scan();
    if (open().length) return revert(current);
    // Plus aucune session exposée : on oublie celles qui sont finies.
    if (Object.keys(windows).length) {
      windows = {};
      saveWindows();
    }
    accept(current);
    return null;
  }

  return {
    // Au démarrage : la référence est l'état du disque (une session exposée avant un redémarrage du
    // coffre reste ouverte, mais ce qui a changé pendant qu'il était arrêté ne peut plus être distingué).
    start() {
      accept(scan());
    },
    check,
    expose(session, role) {
      // Ce qui a changé avant l'exposition est accepté d'abord : ce n'est pas la session exposée.
      track();
      if (!open().length) accept(scan());
      if (!windows[session]) {
        windows[session] = { role, since: now() };
        saveWindows();
      }
    },
    end(session) {
      if (windows[session] && !windows[session].ended) {
        windows[session].ended = now();
        saveWindows();
      }
    },
    open: () => open().map(([session, w]) => ({ session, ...w })),
    // Venu d'une session exposée ? (le disque est relu d'abord : ce qui vient d'apparaître compte)
    tainted(key) {
      track();
      return origins.items[key]?.tainted === true;
    },
    // Marquer (jamais démarquer) : un événement tiré d'un fichier marqué, par exemple.
    taint(key) {
      track();
      origins.items[key] = { ...(origins.items[key] ?? { hash: "", t: now() }), tainted: true };
      saveOrigins();
    },
    // Un fichier que le coffre dépose lui-même dans la boîte : jamais marqué.
    trust(key) {
      origins.trusted = [...origins.trusted.slice(-200), key];
      saveOrigins();
    },
    // Les sessions pi exposées, abandonnées pour la suite.
    poison(piSession) {
      if (!piSession || origins.poisoned.includes(piSession)) return;
      origins.poisoned = [...origins.poisoned.slice(-500), piSession];
      saveOrigins();
    },
    poisoned: () => [...origins.poisoned],
    // La personne accepte des changements retirés : ils sont remis en place, et la référence suit.
    // Pas pendant une exposition, où le gardien les retirerait aussitôt.
    restore(entry) {
      if (open().length) throw Object.assign(new Error("une session exposée est en cours : réessaie quand elle sera finie"), { status: 409 });
      const dir = join(qdir, "held", entry.id);
      for (const c of entry.changes ?? []) {
        if (c.item) {
          const r = RECORDS.find((x) => x.file === c.path);
          if (!r) continue;
          const file = join(root, r.file);
          const unlock = r.lock ? lock(join(root, r.lock)) : () => {};
          try {
            const data = readJson(file) ?? (r.file.endsWith("plan.json") ? { objectives: [], todos: [] } : []);
            const list = [...(r.list(data) ?? [])];
            const i = list.findIndex((x) => x.id === c.item.id);
            if (i === -1) list.push(c.item);
            else for (const f of r.fields) list[i] = { ...list[i], [f]: c.item[f] };
            const tmp = `${file}.guard.tmp`;
            writeFileSync(tmp, JSON.stringify(r.set(data, list), null, 2) + "\n");
            renameSync(tmp, file);
          } finally {
            unlock();
          }
        } else if (existsSync(join(dir, "files", c.path))) {
          mkdirSync(dirname(join(root, c.path)), { recursive: true });
          cpSync(join(dir, "files", c.path), join(root, c.path));
        }
      }
      accept(scan());
    },
  };
}

// Le verrou de plan.json (le même que l'extension dot : un dossier, mkdir est atomique).
function lock(path) {
  const until = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(path);
      return () => rmSync(path, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > 10_000) rmSync(path, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) return () => {};
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
