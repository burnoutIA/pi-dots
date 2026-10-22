// dot — extension pi : ce qui rend l'agent autonome et proactif.
//
// Le dot tourne dans deux rôles :
//
//   - la conversation (le pi de tmux, DOT_ROLE vide) : il parle avec la personne et fait battre le
//     cœur. Le battement (toutes les 15 s, sans modèle) lit le plan et les événements ; quand il y a
//     quelque chose à faire, il lance un run de travail ;
//   - un run de travail (DOT_ROLE=worker) : un pi lancé à part, dans la session de l'objectif
//     concerné, qui fait une seule chose (un todo, un nouveau plan, un événement) puis s'arrête.
//
// Ce qui déclenche un run, dans l'ordre :
//   1. un événement : tâche planifiée échue (`schedule`), veille qui a changé (`watch`), fichier
//      posé dans /dot/inbox ;
//   2. un todo resté en cours (reprise après un arrêt) ou un todo prêt ;
//   3. un objectif actif sans todo ouvert : il faut constater qu'il est atteint, ou refaire le plan.
// Sinon, rien : le modèle n'est pas sollicité. Un run à la fois, et seulement quand la conversation
// est inactive. Chaque run terminé laisse un court compte-rendu dans la conversation.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { log, pruneLogs } from "./log.ts";
import { MEMORY, OPEN, type Plan, type Todo, type Work, newId, nextWork, now, objectiveBlock, readPlan, todoLine, updatePlan } from "./plan.ts";

const HOME = process.env.DOT_HOME ?? "/dot";
const WORKSPACE = join(HOME, "workspace");
const INBOX = join(HOME, "inbox");
const INBOX_DONE = join(INBOX, "traités");
const STATE_FILE = join(MEMORY, "state.json");
const SCHEDULES_FILE = join(MEMORY, "schedules.json");
const WATCHES_FILE = join(MEMORY, "watches.json");

const WORKER = process.env.DOT_ROLE === "worker";
const num = (name: string, fallback: number) => (process.env[name] && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
const RECHECK_MINUTES = num("DOT_RECHECK_MINUTES", num("DOT_HEARTBEAT_MINUTES", 60)); // objectif sans progrès : pas de nouveau plan avant
const RUN_MINUTES = num("DOT_RUN_MINUTES", 30); // durée maximale d'un run
const MAX_RUNS = num("DOT_MAX_RUNS", 3); // runs sur un même todo avant de demander de l'aide
const TICK_MS = num("DOT_TICK_MS", 15_000);
const LOOP_REPEATS = num("DOT_LOOP_REPEATS", 5); // même appel d'outil répété : boucle probable
const LATE_SKIP_MS = 15 * 60_000;
const MAX_TEXT = 4000;

type Kind = "tâche" | "veille" | "boîte";
interface DotEvent { id: string; kind: Kind; text: string; tries?: number }
interface State { paused?: boolean; lastAlive?: string; events: DotEvent[]; running?: { label: string; since: string }; backoffUntil?: string }
interface Schedule { id: string; prompt: string; every?: number; at?: string; days?: number[]; once?: string; catchUp?: boolean; paused?: boolean; lastRun?: string; nextRun: string }
interface Watch { id: string; command: string; every: number; prompt: string; paused?: boolean; hash?: string; output?: string; nextCheck: string }

// --- Fichiers ----------------------------------------------------------------------------------

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(MEMORY, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}
const loadState = (): State => ({ events: [], ...readJson<Partial<State>>(STATE_FILE, {}) }) as State;
function changeState(change: (s: State) => void) {
  const state = loadState();
  change(state);
  writeJson(STATE_FILE, state);
}
const loadSchedules = () => readJson<Schedule[]>(SCHEDULES_FILE, []);
const loadWatches = () => readJson<Watch[]>(WATCHES_FILE, []);

// --- Petits outils ------------------------------------------------------------------------------

const local = (date: Date | string) => new Date(date).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const stamp = () => local(new Date());
const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} caractères coupés]` : text);
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });

function since(iso?: string): string {
  if (!iso) return "jamais";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

function nextAfter(s: Schedule, from: Date): Date | null {
  if (s.once) return s.lastRun ? null : new Date(s.once);
  if (s.every) return new Date(from.getTime() + s.every * 60_000);
  if (s.at) {
    const [h, m] = s.at.split(":").map(Number);
    const candidate = new Date(from);
    candidate.setHours(h, m, 0, 0);
    for (let i = 0; i < 8; i += 1) {
      if (candidate > from && (!s.days?.length || s.days.includes(candidate.getDay()))) return candidate;
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return null;
}

function describeSchedule(s: Schedule): string {
  const when = s.once ? `une fois, le ${local(s.once)}` : s.every ? `toutes les ${s.every} min` : `à ${s.at}${s.days?.length ? ` (jours ${s.days.join(",")})` : " chaque jour"}`;
  return `${s.id} · ${when}${s.paused ? " · en pause" : ` · prochaine : ${local(s.nextRun)}`} · ${s.prompt}`;
}

function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, cwd: WORKSPACE }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === "number" ? `\n[code de sortie ${(error as any).code}]` : error ? `\n[${error.message}]` : "";
      resolve(`${stdout}${stderr ? `\n${stderr}` : ""}${code}`.trim());
    });
  });
}

// --- Partagé entre extensions (et survit au rechargement de session) ---------------------------------

interface Shared {
  send?: (text: string) => void; // posé par dot-telegram
  setPaused: (paused: boolean) => void;
  status: () => string;
}
const shared = ((globalThis as any).__dot ??= {}) as Shared;

shared.setPaused = (paused) => {
  changeState((s) => (s.paused = paused));
  log(paused ? "autonomy.pause" : "autonomy.resume");
};
shared.status = () => {
  const state = loadState();
  const plan = readPlan();
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const schedules = loadSchedules();
  const watches = loadWatches();
  return [
    state.paused ? "⏸ Autonomie en pause (/resume pour reprendre)." : "▶ Autonomie active.",
    state.running ? `En cours : ${state.running.label} (depuis ${since(state.running.since)}).` : "Aucun run en cours.",
    ...(state.events.length ? [`Événements en attente : ${state.events.map((e) => e.kind).join(", ")}.`] : []),
    "",
    `Objectifs (${open.length}) :`,
    ...(open.length ? open.map((o) => objectiveBlock(plan, o, false)) : ["aucun"]),
    "",
    `Tâches planifiées (${schedules.length}) :`,
    ...(schedules.length ? schedules.map((s) => `- ${describeSchedule(s)}`) : ["- aucune"]),
    `Veilles (${watches.length}) :`,
    ...(watches.length ? watches.map((w) => `- ${w.id} · toutes les ${w.every} min${w.paused ? " · en pause" : ""} · ${w.prompt}`) : ["- aucune"]),
  ].join("\n");
};

// --- Les prompts des runs ------------------------------------------------------------------------

function todoPrompt(plan: Plan, work: Extract<Work, { kind: "todo" }>): string {
  const { objective, todo, resume } = work;
  return [
    `[dot:todo] ${stamp()}`,
    `Objectif ${objective.id} : ${objective.title}`,
    "",
    "Plan actuel :",
    objectiveBlock(plan, objective),
    "",
    `Ton todo : ${todo.id} · ${todo.text}`,
    ...(resume ? ["Ce todo était déjà en cours (run interrompu ou pas terminé) : regarde où tu en étais, puis continue."] : []),
    "",
    "Fais ce todo, et seulement lui. Ensuite :",
    "- fini : `todo` done, avec le résultat ;",
    "- il te faut la personne (une information, une décision, un accès) : pose ta question avec `notify`, puis `todo` wait ;",
    "- il faut d'autres étapes : ajoute-les avec `todo` add.",
    "Ta réponse finale est un compte-rendu de deux ou trois lignes.",
  ].join("\n");
}

function planPrompt(plan: Plan, work: Extract<Work, { kind: "plan" }>): string {
  const { objective } = work;
  return [
    `[dot:plan] ${stamp()}`,
    `L'objectif ${objective.id} n'a plus aucun todo ouvert.`,
    "",
    objectiveBlock(plan, objective),
    "",
    "Décide :",
    "- s'il est atteint : `objective` reached, avec le résultat ;",
    "- sinon : fais le plan des prochaines étapes avec `todo` add (petites, concrètes, vérifiables). Ne les exécute pas maintenant ;",
    "- si rien n'est possible pour l'instant : ne change rien et explique pourquoi en une ligne.",
  ].join("\n");
}

function eventPrompt(event: DotEvent): string {
  return `${event.text}\n\nSi cela demande un travail suivi, crée un objectif (\`objective\` add) ou des todos plutôt que de tout faire maintenant. Ta réponse finale est un compte-rendu de deux ou trois lignes.`;
}

// --- Un run de travail : un pi à part, dans la session donnée ------------------------------------

// Le run est journalisé de bout en bout : début, fin, durée, tours, outils appelés, jetons, et
// « loop.suspect » dès qu'un même appel d'outil (même nom, mêmes arguments) se répète
// LOOP_REPEATS fois de suite.
interface RunInfo { label: string; kind: string; session: string; objective?: string; todo?: string }

function runWorker(prompt: string, info: RunInfo): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    log("run.start", { ...info });
    const child = spawn("pi", ["-p", "--mode", "json", "--session-id", info.session, "--", prompt], {
      cwd: WORKSPACE,
      env: { ...process.env, DOT_ROLE: "worker" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let buffer = "";
    let errors = "";
    let timedOut = false;
    const stats = { turns: 0, toolCalls: 0, tools: {} as Record<string, number>, tokensIn: 0, tokensOut: 0, maxRepeat: 0 };
    let lastCall = "";
    let repeat = 0;
    let loopLogged = false;

    function onEvent(event: any) {
      if (event.type === "turn_end") stats.turns += 1;
      const m = event.type === "message_end" ? event.message : null;
      if (m?.role !== "assistant") return;
      stats.tokensIn += Number(m.usage?.input ?? 0) + Number(m.usage?.cacheRead ?? 0);
      stats.tokensOut += Number(m.usage?.output ?? 0);
      const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (t) text = t;
      if (m.errorMessage) errors = String(m.errorMessage);
      for (const call of (m.content ?? []).filter((c: any) => c.type === "toolCall")) {
        stats.toolCalls += 1;
        stats.tools[call.name] = (stats.tools[call.name] ?? 0) + 1;
        const signature = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
        repeat = signature === lastCall ? repeat + 1 : 1;
        lastCall = signature;
        stats.maxRepeat = Math.max(stats.maxRepeat, repeat);
        if (repeat >= LOOP_REPEATS && !loopLogged) {
          loopLogged = true;
          log("loop.suspect", { ...info, repeat, call: signature.slice(0, 300), sinceStartS: Math.round((Date.now() - started) / 1000) });
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          onEvent(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (errors = (errors + String(chunk)).slice(-2000)));
    const timer = setTimeout(() => {
      timedOut = true;
      errors = `run arrêté après ${RUN_MINUTES} min`;
      child.kill("SIGTERM");
    }, RUN_MINUTES * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0 && !!text;
      // SIGKILL sans dépassement de durée : en général, le noyau a tué pi faute de mémoire.
      const killed = signal === "SIGKILL" && !timedOut ? "tué par le système (mémoire ?)" : undefined;
      const result = text || killed || errors.trim() || `pi s'est arrêté (code ${code})`;
      log("run.end", {
        ...info,
        ok,
        code,
        signal: signal ?? undefined,
        timedOut: timedOut || undefined,
        durationS: Math.round((Date.now() - started) / 1000),
        ...stats,
        error: ok ? undefined : (killed ?? errors.trim().slice(0, 500)) || undefined,
        report: text.slice(0, 300) || undefined,
      });
      resolve({ ok, text: result });
    });
  });
}

// --- Rappel des fichiers persistants dans le prompt système ---------------------------------------

function memorySection(): string {
  const read = (name: string) => {
    try {
      return readFileSync(join(MEMORY, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const plan = readPlan();
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const journal = read("JOURNAL.md").split("\n").slice(-25).join("\n");
  return [
    `## MEMORY.md\n${read("MEMORY.md")}`,
    `## Objectifs en cours\n${open.length ? open.map((o) => objectiveBlock(plan, o, false)).join("\n\n") : "Aucun."}`,
    `## JOURNAL.md (fin)\n${journal}`,
  ].join("\n\n");
}

// --- L'extension -----------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let atStart = "";
  pi.on("session_start", () => {
    mkdirSync(MEMORY, { recursive: true });
    atStart = memorySection();
  });
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      dot_role: WORKER
        ? "This is a work run: you were started on your own, on one precise job (described in the message). Nobody reads this run live. Do the job, keep the plan up to date with `todo` / `objective`, use `notify` only for what the person must know, and finish with a short report."
        : "This is your conversation with the person. Your work on objectives runs separately (one session per objective); its reports reach this conversation as `[dot:compte-rendu]` messages. To start some work, create an objective or todos: the work runs will take them up.",
      dot_memory: `Your persistent state, as it was when this session started (read /dot/memory again for the current version):\n\n${atStart}`,
    };
  });

  registerTools(pi);
  if (WORKER) return;

  // ===== Conversation : le battement ==========================================================

  let ctx: any = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const checking = new Set<string>();

  const enqueue = (kind: Kind, text: string, detail: Record<string, unknown> = {}) => {
    const id = newId();
    changeState((s) => s.events.push({ id, kind, text }));
    log("event.queued", { event: id, kind, ...detail });
  };

  function dueSchedules(at: Date) {
    const schedules = loadSchedules();
    let changed = false;
    for (const s of [...schedules]) {
      if (s.paused || at < new Date(s.nextRun)) continue;
      const late = at.getTime() - new Date(s.nextRun).getTime();
      if (s.catchUp !== false || late <= LATE_SKIP_MS) {
        const missed = late > LATE_SKIP_MS ? ` (prévue le ${local(s.nextRun)}, lancée en retard : l'environnement était éteint)` : "";
        enqueue("tâche", `[dot:tâche] ${stamp()}\nTâche planifiée ${s.id}${missed} :\n${s.prompt}`, { schedule: s.id, lateMin: Math.round(late / 60_000) });
      } else {
        log("schedule.skipped", { schedule: s.id, lateMin: Math.round(late / 60_000) });
      }
      s.lastRun = at.toISOString();
      const next = nextAfter(s, at);
      if (next) s.nextRun = next.toISOString();
      else schedules.splice(schedules.indexOf(s), 1);
      changed = true;
    }
    if (changed) writeJson(SCHEDULES_FILE, schedules);
  }

  function dueWatches(at: Date) {
    for (const w of loadWatches()) {
      if (w.paused || checking.has(w.id) || at < new Date(w.nextCheck)) continue;
      checking.add(w.id);
      void shell(w.command).then((output) => {
        checking.delete(w.id);
        const watches = loadWatches();
        const current = watches.find((x) => x.id === w.id);
        if (!current) return;
        const hash = createHash("sha256").update(output).digest("hex");
        if (current.hash && current.hash !== hash) {
          enqueue("veille", `[dot:veille] ${stamp()}\nLa veille ${w.id} a changé.\nCe qu'elle surveille : ${w.prompt}\nCommande : ${w.command}\n\nAvant :\n${cut(current.output ?? "", 1500)}\n\nMaintenant :\n${cut(output, 2500)}`, { watch: w.id });
        }
        current.hash = hash;
        current.output = cut(output);
        current.nextCheck = later(current.every);
        writeJson(WATCHES_FILE, watches);
      });
    }
  }

  function inbox() {
    if (!existsSync(INBOX)) return;
    for (const name of readdirSync(INBOX)) {
      if (name.startsWith(".")) continue;
      const file = join(INBOX, name);
      const info = statSync(file);
      if (!info.isFile() || Date.now() - info.mtimeMs < 2000) continue;
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {}
      mkdirSync(INBOX_DONE, { recursive: true });
      renameSync(file, join(INBOX_DONE, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`));
      enqueue("boîte", `[dot:boîte] ${stamp()}\nLa personne a déposé « ${name} » dans la boîte :\n${cut(text)}`, { file: name });
    }
  }

  // Compte-rendu d'un run, ajouté à la conversation sans relancer le modèle.
  function report(label: string, text: string) {
    const content = `[dot:compte-rendu] ${stamp()} · ${label}\n${cut(text, 1500)}`;
    try {
      pi.sendMessage({ customType: "dot-run", content, display: true }, ctx?.isIdle?.() ? {} : { deliverAs: "nextTurn" });
    } catch {}
    appendFileSync(join(MEMORY, "JOURNAL.md"), `\n- ${stamp()} · ${label} — ${text.split("\n")[0].slice(0, 300)}\n`);
  }

  // Un todo que le run n'a pas conclu reste en cours ; au-delà de MAX_RUNS, on demande de l'aide.
  function afterTodo(todoId: string, ok: boolean, text: string) {
    const stuck = updatePlan((plan) => {
      const todo = plan.todos.find((t) => t.id === todoId);
      if (!todo || !["todo", "doing"].includes(todo.status)) return null;
      todo.runs += 1;
      todo.updated = now();
      if (todo.runs >= MAX_RUNS) {
        todo.status = "waiting";
        todo.reason = `pas terminé après ${todo.runs} runs${ok ? "" : ` (${text.slice(0, 200)})`}`;
        return todo;
      }
      todo.status = "doing";
      return null;
    });
    if (stuck) {
      log("todo.stuck", { objective: stuck.objective, todo: stuck.id, runs: stuck.runs, reason: stuck.reason });
      shared.send?.(`Je bloque sur « ${stuck.text} » (${stuck.reason}). Peux-tu m'aider ou me dire comment continuer ?`);
    }
  }

  async function work(): Promise<void> {
    const state = loadState();
    // 1. Événements
    const event = state.events[0];
    if (event) {
      const label = `événement (${event.kind})`;
      changeState((s) => (s.running = { label, since: now() }));
      const result = await runWorker(eventPrompt(event), { label, kind: `event:${event.kind}`, session: "dot-evenements" });
      changeState((s) => {
        delete s.running;
        const e = s.events.find((x) => x.id === event.id);
        if (!e) return;
        e.tries = (e.tries ?? 0) + 1;
        if (result.ok || e.tries >= 3) s.events = s.events.filter((x) => x.id !== event.id);
        if (!result.ok) s.backoffUntil = later(2);
      });
      report(label, result.text);
      return;
    }

    // 2 et 3. Le plan
    const plan = readPlan();
    const next = nextWork(plan);
    if (!next) return;
    const objective = next.objective;
    const sessionId = `dot-objectif-${objective.id}`;

    if (next.kind === "todo") {
      updatePlan((p) => {
        const t = p.todos.find((x) => x.id === next.todo.id);
        if (t) Object.assign(t, { status: "doing", updated: now() });
      });
      const label = `${objective.title} · ${next.todo.text}`;
      changeState((s) => (s.running = { label, since: now() }));
      const result = await runWorker(todoPrompt(readPlan(), next), {
        label,
        kind: next.resume ? "todo:reprise" : "todo",
        session: sessionId,
        objective: objective.id,
        todo: next.todo.id,
      });
      changeState((s) => {
        delete s.running;
        if (!result.ok) s.backoffUntil = later(2);
      });
      afterTodo(next.todo.id, result.ok, result.text);
      report(label, result.text);
      return;
    }

    // Nouveau plan : s'il ne change rien, l'objectif n'est réexaminé qu'après RECHECK_MINUTES.
    const fingerprint = (p: Plan) => JSON.stringify([p.objectives.find((o) => o.id === objective.id)?.status, p.todos.filter((t) => t.objective === objective.id).map((t) => [t.id, t.status])]);
    const before = fingerprint(plan);
    const label = `${objective.title} · plan`;
    changeState((s) => (s.running = { label, since: now() }));
    const result = await runWorker(planPrompt(plan, next), { label, kind: "plan", session: sessionId, objective: objective.id });
    changeState((s) => {
      delete s.running;
      if (!result.ok) s.backoffUntil = later(2);
    });
    const unchanged = updatePlan((p) => {
      const o = p.objectives.find((x) => x.id === objective.id);
      if (!o || fingerprint(p) !== before) return false;
      o.idleUntil = later(RECHECK_MINUTES);
      return true;
    });
    if (unchanged) log("plan.unchanged", { objective: objective.id, recheckInMin: RECHECK_MINUTES });
    report(label, result.text);
  }

  function tick() {
    const at = new Date();
    changeState((s) => (s.lastAlive = at.toISOString()));
    dueSchedules(at);
    dueWatches(at);
    inbox();

    const state = loadState();
    if (running || state.paused) return;
    if (state.backoffUntil && new Date(state.backoffUntil) > at) return;
    if (ctx?.isIdle?.() !== true) return; // la personne d'abord
    running = true;
    work()
      .catch((error) => {
        log("heartbeat.error", { error: String(error?.stack ?? error).slice(0, 1000) });
        report("erreur du battement", String(error?.message ?? error));
      })
      .finally(() => (running = false));
  }

  pi.on("session_start", (_event, context: any) => {
    ctx = context;
    mkdirSync(INBOX, { recursive: true });
    pruneLogs();
    // Un run coupé par un arrêt : son todo est resté « en cours » et sera repris au premier battement.
    const state = loadState();
    const doing = readPlan().todos.filter((t) => t.status === "doing").map((t) => t.id);
    log("conversation.start", { interrupted: state.running?.label, todosInProgress: doing.length ? doing : undefined, paused: state.paused || undefined });
    changeState((s) => delete s.running);
    if (!timer) timer = setInterval(tick, TICK_MS);
  });
  pi.on("session_shutdown", () => {
    log("conversation.stop");
    if (timer) clearInterval(timer);
    timer = null;
    ctx = null;
  });

  pi.registerCommand("dot-status", {
    description: "État du dot : objectifs, run en cours, tâches, veilles",
    handler: async (_args, context: any) => context.ui.notify(shared.status(), "info"),
  });
  pi.registerCommand("dot-pause", {
    description: "Mettre l'autonomie en pause (plus aucun run de travail)",
    handler: async (_args, context: any) => {
      shared.setPaused(true);
      context.ui.notify("Autonomie en pause.", "info");
    },
  });
  pi.registerCommand("dot-resume", {
    description: "Reprendre l'autonomie",
    handler: async (_args, context: any) => {
      shared.setPaused(false);
      context.ui.notify("Autonomie reprise.", "info");
    },
  });
}

// --- Outils : les mêmes dans la conversation et dans les runs -------------------------------------

function registerTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "notify",
    label: "notify",
    description:
      "Send a message to the person (on Telegram when configured). Use it when you work on your own and have something worth their attention: a result, a question that blocks you, a decision they must take. Do not use it to say everything is fine.",
    promptSnippet: "notify: send a message to the person while you work on your own",
    parameters: Type.Object({ text: Type.String({ description: "The message, short and self-contained" }) }),
    async execute(_id: string, args: any) {
      const text = String(args.text ?? "").trim();
      if (!text) return answer("Empty message.", true);
      log("notify", { text: text.slice(0, 300), channel: shared.send ? "telegram" : "file" });
      if (shared.send) {
        shared.send(text);
        return answer("Sent to the person.");
      }
      appendFileSync(join(MEMORY, "NOTIFICATIONS.md"), `\n## ${stamp()}\n${text}\n`);
      return answer(`No messaging channel is configured: the message was written to ${join(MEMORY, "NOTIFICATIONS.md")}.`);
    },
  });

  pi.registerTool({
    name: "objective",
    label: "objective",
    description:
      "Manage your objectives: the lasting things you work towards, on your own, across restarts. Each active objective is worked on through its todos; when it has no open todo left, you are asked to check whether it is reached or to plan the next todos. " +
      "action: `add` (title, detail), `list`, `update` (id, title and/or detail), `reached` (id, result), `pause` / `resume` (id), `drop` (id, reason).",
    promptSnippet: "objective: add, update, close or list your lasting objectives",
    promptGuidelines: [
      "Create an objective with `objective` when the person asks for something that takes more than one step or must be followed over time; then plan its first todos with `todo` add.",
      "An objective is reached only when its result can be checked; mark it `reached` with that result.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "add | list | update | reached | pause | resume | drop" }),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ description: "Short title of the objective" })),
      detail: Type.Optional(Type.String({ description: "What success looks like, constraints, context" })),
      result: Type.Optional(Type.String({ description: "With `reached`: the result, checkable" })),
      reason: Type.Optional(Type.String({ description: "With `drop`: why" })),
    }),
    async execute(_id: string, args: any) {
      const plan = readPlan();
      if (args.action === "list") {
        return answer(plan.objectives.length ? plan.objectives.map((o) => objectiveBlock(plan, o, o.status === "active" || o.status === "paused")).join("\n\n") : "No objective.");
      }
      if (args.action === "add") {
        const title = String(args.title ?? "").trim();
        if (!title) return answer("`add` needs a title.", true);
        const id = newId();
        updatePlan((p) => p.objectives.push({ id, title, detail: args.detail?.trim() || undefined, status: "active", created: now(), updated: now() }));
        log("plan.change", { tool: "objective", action: "add", objective: id, title });
        return answer(`Objective ${id} added. Plan its first todos with \`todo\` add (objective: ${id}).`);
      }
      const found = updatePlan((p) => {
        const o = p.objectives.find((x) => x.id === args.id);
        if (!o) return null;
        switch (args.action) {
          case "update":
            if (args.title) o.title = String(args.title).trim();
            if (args.detail !== undefined) o.detail = String(args.detail).trim() || undefined;
            break;
          case "reached":
            o.status = "reached";
            o.result = String(args.result ?? "").trim() || undefined;
            break;
          case "pause":
            o.status = "paused";
            break;
          case "resume":
            o.status = "active";
            break;
          case "drop":
            o.status = "dropped";
            o.result = String(args.reason ?? "").trim() || undefined;
            for (const t of p.todos) if (t.objective === o.id && OPEN.includes(t.status)) Object.assign(t, { status: "dropped", reason: "objectif abandonné", updated: now() });
            break;
          default:
            return "unknown";
        }
        o.updated = now();
        delete o.idleUntil; // un objectif modifié mérite d'être réexaminé
        return o;
      });
      if (found === "unknown") return answer("Unknown action: use add, list, update, reached, pause, resume or drop.", true);
      if (!found) return answer(`No objective ${args.id}.`, true);
      log("plan.change", { tool: "objective", action: args.action, objective: found.id, status: found.status });
      return answer(objectiveBlock(readPlan(), found));
    },
  });

  pi.registerTool({
    name: "todo",
    label: "todo",
    description:
      "Manage the todos of an objective: the concrete steps that lead to it. Each ready todo is taken up by a work run, one at a time. " +
      "action: `add` (objective, text, optional not_before), `list` (optional objective), `done` (id, result), `wait` (id, reason: you need the person or something external), `reopen` (id, optional text: e.g. after the person answered), `drop` (id, reason).",
    promptSnippet: "todo: add, complete, block, reopen or list the steps of an objective",
    promptGuidelines: [
      "Keep todos small, concrete and checkable. Add the next ones as soon as you know them.",
      "When the person answers a question a todo was waiting for, `reopen` it with what they said.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "add | list | done | wait | reopen | drop" }),
      id: Type.Optional(Type.String({ description: "Todo id" })),
      objective: Type.Optional(Type.String({ description: "Objective id (for add, or to filter list)" })),
      text: Type.Optional(Type.String({ description: "The step, as an action (for add, or to rewrite it on reopen)" })),
      not_before: Type.Optional(Type.String({ description: "With add: do not start before this local date-time (ISO, 2026-10-23T09:00)" })),
      result: Type.Optional(Type.String({ description: "With done: what was done or found" })),
      reason: Type.Optional(Type.String({ description: "With wait or drop: why" })),
    }),
    async execute(_id: string, args: any) {
      const plan = readPlan();
      if (args.action === "list") {
        const todos = plan.todos.filter((t) => !args.objective || t.objective === args.objective);
        return answer(todos.length ? todos.map((t) => `${todoLine(t)} [objective ${t.objective}]`).join("\n") : "No todo.");
      }
      if (args.action === "add") {
        const text = String(args.text ?? "").trim();
        if (!text) return answer("`add` needs text.", true);
        if (!plan.objectives.some((o) => o.id === args.objective)) return answer(`No objective ${args.objective}. Create it first with \`objective\` add.`, true);
        if (args.not_before && Number.isNaN(new Date(args.not_before).getTime())) return answer("`not_before` is not a valid date.", true);
        const todo: Todo = { id: newId(), objective: args.objective, text, status: "todo", runs: 0, created: now(), updated: now() };
        if (args.not_before) todo.notBefore = new Date(args.not_before).toISOString();
        updatePlan((p) => {
          p.todos.push(todo);
          const o = p.objectives.find((x) => x.id === todo.objective);
          if (o) delete o.idleUntil;
        });
        log("plan.change", { tool: "todo", action: "add", objective: todo.objective, todo: todo.id, text: todo.text.slice(0, 200) });
        return answer(`Todo ${todo.id} added: ${todo.text}`);
      }
      const found = updatePlan((p) => {
        const t = p.todos.find((x) => x.id === args.id);
        if (!t) return null;
        switch (args.action) {
          case "done":
            t.status = "done";
            t.result = String(args.result ?? "").trim() || undefined;
            break;
          case "wait":
            t.status = "waiting";
            t.reason = String(args.reason ?? "").trim() || undefined;
            break;
          case "reopen":
            t.status = "todo";
            t.runs = 0;
            delete t.reason;
            if (args.text) t.text = String(args.text).trim();
            break;
          case "drop":
            t.status = "dropped";
            t.reason = String(args.reason ?? "").trim() || undefined;
            break;
          default:
            return "unknown";
        }
        t.updated = now();
        const o = p.objectives.find((x) => x.id === t.objective);
        if (o) delete o.idleUntil;
        return t;
      });
      if (found === "unknown") return answer("Unknown action: use add, list, done, wait, reopen or drop.", true);
      if (!found) return answer(`No todo ${args.id}.`, true);
      log("plan.change", { tool: "todo", action: args.action, objective: found.objective, todo: found.id, status: found.status, reason: found.reason });
      return answer(todoLine(found));
    },
  });

  pi.registerTool({
    name: "schedule",
    label: "schedule",
    description:
      "Manage scheduled tasks. When a task is due, a work run receives its prompt as a `[dot:tâche]` message. " +
      "action: `add` (prompt and exactly one of every_minutes, at, once), `list`, `remove`, `pause`, `resume` (id). " +
      "Tasks survive restarts; a task due while the environment was off runs at the next start unless catch_up is false.",
    promptSnippet: "schedule: run a prompt later, at a fixed time, or on a recurring basis",
    parameters: Type.Object({
      action: Type.String({ description: "add | list | remove | pause | resume" }),
      id: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String({ description: "What to do when the task is due, written for yourself" })),
      every_minutes: Type.Optional(Type.Number({ description: "Repeat every N minutes" })),
      at: Type.Optional(Type.String({ description: "Local time HH:MM, every day (or on `days`)" })),
      days: Type.Optional(Type.Array(Type.Number(), { description: "With `at`: days of the week, 0 = Sunday … 6 = Saturday" })),
      once: Type.Optional(Type.String({ description: "Run once at this local date-time, ISO (2026-10-23T09:00)" })),
      catch_up: Type.Optional(Type.Boolean({ description: "Run at next start if missed while off (default true)" })),
    }),
    async execute(_id: string, args: any) {
      const schedules = loadSchedules();
      const find = () => schedules.find((s) => s.id === args.id);
      switch (args.action) {
        case "list":
          return answer(schedules.length ? schedules.map(describeSchedule).join("\n") : "No scheduled task.");
        case "add": {
          const prompt = String(args.prompt ?? "").trim();
          const kinds = [args.every_minutes, args.at, args.once].filter((v) => v !== undefined && v !== "");
          if (!prompt || kinds.length !== 1) return answer("`add` needs a prompt and exactly one of every_minutes, at, once.", true);
          if (args.at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(args.at)) return answer("`at` must be HH:MM.", true);
          if (args.every_minutes !== undefined && !(args.every_minutes >= 1)) return answer("`every_minutes` must be at least 1.", true);
          if (args.once && Number.isNaN(new Date(args.once).getTime())) return answer("`once` is not a valid date.", true);
          const s: Schedule = { id: newId(), prompt, nextRun: "" };
          if (args.every_minutes !== undefined) s.every = Number(args.every_minutes);
          if (args.at) s.at = args.at;
          if (Array.isArray(args.days) && args.days.length) s.days = args.days.map(Number).filter((d: number) => d >= 0 && d <= 6);
          if (args.once) s.once = new Date(args.once).toISOString();
          if (args.catch_up === false) s.catchUp = false;
          const next = nextAfter(s, new Date());
          if (!next) return answer("This task would never run.", true);
          s.nextRun = next.toISOString();
          schedules.push(s);
          writeJson(SCHEDULES_FILE, schedules);
          return answer(`Scheduled: ${describeSchedule(s)}`);
        }
        case "remove": {
          const s = find();
          if (!s) return answer(`No task ${args.id}.`, true);
          schedules.splice(schedules.indexOf(s), 1);
          writeJson(SCHEDULES_FILE, schedules);
          return answer(`Removed ${s.id}.`);
        }
        case "pause":
        case "resume": {
          const s = find();
          if (!s) return answer(`No task ${args.id}.`, true);
          s.paused = args.action === "pause";
          if (!s.paused) {
            const next = nextAfter(s, new Date());
            if (next) s.nextRun = next.toISOString();
          }
          writeJson(SCHEDULES_FILE, schedules);
          return answer(describeSchedule(s));
        }
        default:
          return answer("Unknown action: use add, list, remove, pause or resume.", true);
      }
    },
  });

  pi.registerTool({
    name: "watch",
    label: "watch",
    description:
      "Watch something by running a shell command regularly inside your environment (no model involved). When its output changes, a work run receives a `[dot:veille]` message with the old and new output. " +
      "The first run only records a baseline. action: `add` (command, every_minutes, prompt), `list`, `remove` / `pause` / `resume` (id). " +
      "Make the command print only what matters (a title, a count, a version), so harmless noise does not trigger a run.",
    promptSnippet: "watch: trigger a run when the output of a command changes",
    parameters: Type.Object({
      action: Type.String({ description: "add | list | remove | pause | resume" }),
      id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String({ description: "Shell command (bash) whose output is watched" })),
      every_minutes: Type.Optional(Type.Number({ description: "How often to run it, in minutes (at least 1)" })),
      prompt: Type.Optional(Type.String({ description: "What this watch is for and what to do when it changes, written for yourself" })),
    }),
    async execute(_id: string, args: any) {
      const watches = loadWatches();
      const find = () => watches.find((w) => w.id === args.id);
      const show = (w: Watch) => `${w.id} · every ${w.every} min${w.paused ? " · paused" : ""} · ${w.command} · ${w.prompt}`;
      switch (args.action) {
        case "list":
          return answer(watches.length ? watches.map(show).join("\n") : "No watch.");
        case "add": {
          const command = String(args.command ?? "").trim();
          const prompt = String(args.prompt ?? "").trim();
          const every = Number(args.every_minutes);
          if (!command || !prompt || !(every >= 1)) return answer("`add` needs command, prompt and every_minutes (≥ 1).", true);
          const w: Watch = { id: newId(), command, every, prompt, nextCheck: now() };
          watches.push(w);
          writeJson(WATCHES_FILE, watches);
          return answer(`Watching: ${show(w)}`);
        }
        case "remove": {
          const w = find();
          if (!w) return answer(`No watch ${args.id}.`, true);
          watches.splice(watches.indexOf(w), 1);
          writeJson(WATCHES_FILE, watches);
          return answer(`Removed ${w.id}.`);
        }
        case "pause":
        case "resume": {
          const w = find();
          if (!w) return answer(`No watch ${args.id}.`, true);
          w.paused = args.action === "pause";
          writeJson(WATCHES_FILE, watches);
          return answer(show(w));
        }
        default:
          return answer("Unknown action: use add, list, remove, pause or resume.", true);
      }
    },
  });
}
